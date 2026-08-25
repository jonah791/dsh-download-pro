/** dsh-download-pro · aria2 JSON-RPC 客户端 + 守护进程管理
 *  - daemon 以 detached 独立进程存活（web 重启不中断下载）
 *  - RPC 只监听 127.0.0.1 + 随机 token 认证（凭据持久化在插件 data 目录，可跨重启复用）
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface Aria2Config {
  rpcPort: number
  dir: string
  maxConcurrent: number
  rpcSecret?: string
}

export interface Aria2Task {
  gid: string
  status: string // active / waiting / paused / error / complete / removed
  name: string
  totalLength: number
  completedLength: number
  downloadSpeed: number
  uploadSpeed: number
  progress: number // 0-100
  dir: string
  errorMessage?: string
  errorCode?: string
  numSeeders?: number
  connections?: number
  files: { path: string; length: number; completedLength: number }[]
}

export class Aria2Client {
  private secret: string
  private port: number
  private dir: string
  private maxConcurrent: number
  private dataDir: string
  private proc: ChildProcess | null = null
  private seq = 0

  constructor(cfg: Aria2Config, dataDir: string) {
    this.port = cfg.rpcPort
    this.dir = cfg.dir
    this.maxConcurrent = cfg.maxConcurrent
    this.dataDir = dataDir
    this.secret = cfg.rpcSecret && cfg.rpcSecret.length > 0 ? cfg.rpcSecret : this.loadOrCreateSecret()
  }

  /** 从插件 data 目录读取或生成 RPC token（持久化，跨 web 重启复用） */
  private loadOrCreateSecret(): string {
    const p = path.join(this.dataDir, 'token')
    try {
      if (existsSync(p)) {
        const t = readFileSync(p, 'utf8').trim()
        if (t) return t
      }
    } catch { /* 忽略读取失败，重新生成 */ }
    const t = randomBytes(16).toString('hex')
    try {
      mkdirSync(this.dataDir, { recursive: true })
      writeFileSync(p, t, 'utf8')
    } catch { /* 写失败不致命，仅本次会话有效 */ }
    return t
  }

  /** JSON-RPC 调用（secret 认证模式：首参为 token:xxx） */
  async rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: ++this.seq,
      method,
      params: [`token:${this.secret}`, ...params],
    })
    const res = await fetch(`http://127.0.0.1:${this.port}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      // aria2 对语义错误（如暂停已完成任务）返回 HTTP 4xx + JSON-RPC error body
      let msg = `aria2 RPC HTTP ${res.status}`
      try {
        const d = await res.json() as { error?: { message?: string } }
        if (d.error?.message) msg = `aria2: ${d.error.message}`
      } catch { /* 非 JSON body，保留 HTTP 状态信息 */ }
      throw new Error(msg)
    }
    const data = await res.json() as { result?: T; error?: { code: number; message: string } }
    if (data.error) throw new Error(`aria2 error ${data.error.code}: ${data.error.message}`)
    return data.result as T
  }

  async ping(): Promise<boolean> {
    try {
      await this.rpc('aria2.getVersion')
      return true
    } catch { return false }
  }

  /** 确保 daemon 存活：ping 不通则 spawn 并等待就绪 */
  async ensure(): Promise<void> {
    if (await this.ping()) return
    this.spawn()
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (await this.ping()) return
    }
    throw new Error('aria2 守护进程启动超时（20s）')
  }

  private spawn(): void {
    const args = [
      '--enable-rpc',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${this.port}`,
      `--rpc-secret=${this.secret}`,
      `--dir=${this.dir}`,
      `--max-concurrent-downloads=${this.maxConcurrent}`,
      '--max-connection-per-server=16',
      '--split=16',
      '--min-split-size=1M',
      '--continue=true',
      '--file-allocation=none',
      '--seed-time=0',
      '--enable-dht=true',
      '--dht-listen-port=46000-47000', // 避开 Windows 排除端口范围 6644-7043（Hyper-V/WinNAT 保留）
      '--listen-port=46000-47000', // BT 监听默认 6881-6999 也在排除范围内，必须显式指定
      '--enable-peer-exchange=true',
      // DHT bootstrap 节点：加速 DHT 路由表建立（冷启动时节点发现慢；--dht-entry-point 只接受单个 HOST:PORT，需重复指定）
      '--dht-entry-point=dht.transmissionbt.com:6881',
      '--dht-entry-point=router.bittorrent.com:6881',
      '--dht-entry-point=router.utorrent.com:6881',
      '--dht-entry-point=dht.libtorrent.org:25401',
      // 每任务最大 peer 数：默认 55，冷门资源调大增加发现机会
      '--bt-max-peers=300',
      // 任务会话持久化：跨重启恢复任务（配合 --continue）
      `--save-session=${path.join(this.dataDir, 'session').replace(/\\/g, '/')}`,
      '--save-session-interval=60',
      // 公共 tracker 列表：DHT 冷启动慢 + 冷门资源常缺 DHT 节点，tracker 显著提升磁力元数据解析率
      '--bt-tracker=' + [
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://open.demonii.com:1337/announce',
        'udp://tracker.openbittorrent.com:6969/announce',
        'udp://exodus.desync.com:6969/announce',
        'udp://tracker.torrent.eu.org:451/announce',
        'udp://tracker.moeking.me:6969/announce',
        'udp://open.stealth.si:80/announce',
        'https://tracker.gbitt.info/announce',
        'http://tracker.openbittorrent.com:80/announce',
      ].join(','),
      '--allow-overwrite=false',
      '--auto-file-renaming=true',
      '--console-log-level=warn',
      '--summary-interval=0',
      '--quiet=true',
    ]
    this.proc = spawn('aria2c', args, { detached: true, windowsHide: true, stdio: 'ignore' })
    this.proc.unref()
  }

  /** 优雅关闭 daemon（停止所有任务） */
  async shutdown(): Promise<void> {
    try { await this.rpc('aria2.shutdown') } catch { /* daemon 可能已不在 */ }
    this.proc = null
  }

  // ── 任务操作 ──
  async add(uris: string[], opts: { dir?: string; out?: string; seed?: boolean } = {}): Promise<string> {
    const options: Record<string, string> = {}
    if (opts.dir) options.dir = opts.dir
    if (opts.out) options.out = opts.out
    if (opts.seed) {
      options['seed-time'] = '0'
      options['bt-seed-unverified'] = 'true'
    }
    return await this.rpc<string>('aria2.addUri', [uris, options])
  }

  private mapTask(t: any): Aria2Task {
    const files = (t.files ?? []).map((f: any) => ({
      path: f.path ?? '',
      length: Number(f.length ?? 0),
      completedLength: Number(f.completedLength ?? 0),
    }))
    const name = t.bittorrent?.info?.name ?? (files[0] ? path.basename(files[0].path) : t.gid)
    const total = Number(t.totalLength ?? 0)
    const done = Number(t.completedLength ?? 0)
    return {
      gid: t.gid,
      status: t.status,
      name,
      totalLength: total,
      completedLength: done,
      downloadSpeed: Number(t.downloadSpeed ?? 0),
      uploadSpeed: Number(t.uploadSpeed ?? 0),
      progress: total > 0 ? Math.round((done / total) * 1000) / 10 : 0,
      dir: t.dir ?? '',
      errorMessage: t.errorMessage ?? '',
      errorCode: t.errorCode ? String(t.errorCode) : '',
      numSeeders: t.numSeeders != null ? Number(t.numSeeders) : 0,
      connections: t.connections != null ? Number(t.connections) : 0,
      files,
    }
  }

  async active(): Promise<Aria2Task[]> {
    const list = await this.rpc<any[]>('aria2.tellActive', [])
    return (list ?? []).map((t) => this.mapTask(t))
  }

  async waiting(offset = 0, num = 100): Promise<Aria2Task[]> {
    const list = await this.rpc<any[]>('aria2.tellWaiting', [offset, num])
    return (list ?? []).map((t) => this.mapTask(t))
  }

  async stopped(offset = 0, num = 30): Promise<Aria2Task[]> {
    const list = await this.rpc<any[]>('aria2.tellStopped', [offset, num])
    return (list ?? []).map((t) => this.mapTask(t))
  }

  async status(gid: string): Promise<Aria2Task> {
    const t = await this.rpc<any>('aria2.tellStatus', [gid])
    if (!t) throw new Error(`任务不存在: ${gid}`)
    return this.mapTask(t)
  }

  async pause(gid: string): Promise<void> {
    await this.rpc('aria2.pause', [gid])
  }

  async resume(gid: string): Promise<void> {
    await this.rpc('aria2.unpause', [gid])
  }

  /** 移除任务：active/waiting/paused 用 remove/forceRemove；complete/error/removed 用 removeDownloadResult */
  async remove(gid: string, force = false): Promise<void> {
    const t = await this.status(gid)
    if (t.status === 'complete' || t.status === 'removed' || t.status === 'error') {
      await this.rpc('aria2.removeDownloadResult', [gid])
    } else {
      await this.rpc(force ? 'aria2.forceRemove' : 'aria2.remove', [gid])
    }
  }

  async globalStat(): Promise<{
    downloadSpeed: number; uploadSpeed: number
    numActive: number; numWaiting: number; numStopped: number; numStoppedTotal: number
  }> {
    const s = await this.rpc<any>('aria2.getGlobalStat', [])
    return {
      downloadSpeed: Number(s?.downloadSpeed ?? 0),
      uploadSpeed: Number(s?.uploadSpeed ?? 0),
      numActive: Number(s?.numActive ?? 0),
      numWaiting: Number(s?.numWaiting ?? 0),
      numStopped: Number(s?.numStopped ?? 0),
      numStoppedTotal: Number(s?.numStoppedTotal ?? 0),
    }
  }

  /** 设置全局限速（KB/s，<=0 = 不限） */
  async setGlobalLimit(downloadK: number, uploadK: number): Promise<void> {
    const opts: Record<string, string> = {}
    opts['max-overall-download-limit'] = downloadK <= 0 ? '0' : `${downloadK}K`
    opts['max-overall-upload-limit'] = uploadK <= 0 ? '0' : `${uploadK}K`
    await this.rpc('aria2.changeGlobalOption', [opts])
  }
}
