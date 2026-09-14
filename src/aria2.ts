/** dsh-download-pro · aria2 JSON-RPC 客户端 + 守护进程管理
 *  - daemon 以 detached 独立进程存活（web 重启不中断下载）
 *  - RPC 只监听 127.0.0.1 + 随机 token 认证（凭据持久化在插件 data 目录，可跨重启复用）
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  buildDaemonArgs, buildAddOptions, buildLimitOptions, buildRpcBody,
  rpcErrorMessage, rpcBodyError, mapTask, mapGlobalStat, removeRpcMethod,
  describeSpawnFailure, type Aria2Task, type GlobalStat,
} from './logic.js'

export type { Aria2Task, GlobalStat } from './logic.js'

export interface Aria2Config {
  rpcPort: number
  dir: string
  maxConcurrent: number
  rpcSecret?: string
}

export class Aria2Client {
  private secret: string
  private port: number
  private dir: string
  private maxConcurrent: number
  private dataDir: string
  private proc: ChildProcess | null = null
  private seq = 0
  /** spawn 层失败原因（如 ENOENT）。由 `'error'` 监听器写入——**必须被消费**：
   *  未处理的 `'error'` 事件会被 Node 抛成未捕获异常并打崩宿主进程。 */
  private spawnError: string | null = null

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
    const body = buildRpcBody(method, params, this.secret, ++this.seq)
    const res = await fetch(`http://127.0.0.1:${this.port}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    if (!res.ok) {
      // aria2 对语义错误（如暂停已完成任务）返回 HTTP 4xx + JSON-RPC error body
      throw new Error(rpcErrorMessage(res.status, text))
    }
    const bodyErr = rpcBodyError(text)
    if (bodyErr) throw new Error(bodyErr)
    return JSON.parse(text).result as T
  }

  async ping(): Promise<boolean> {
    try {
      await this.rpc('aria2.getVersion')
      return true
    } catch { return false }
  }

  /** 确保 daemon 存活：ping 不通则 spawn 并等待就绪。
   *  spawn 层失败（`aria2c` 不在 PATH）不再打成未捕获异常——改为**显式抛错**，
   *  由调用方 `safe()` 收成 `{ok:false, error}`（失败必须说清下一步动作）。 */
  async ensure(): Promise<void> {
    if (await this.ping()) return
    this.spawnError = null
    this.spawn()
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (this.spawnError) throw new Error(this.spawnError)
      if (await this.ping()) return
    }
    if (this.spawnError) throw new Error(this.spawnError)
    throw new Error('aria2 守护进程启动超时（20s）')
  }

  private spawn(): void {
    const args = buildDaemonArgs(
      { rpcPort: this.port, dir: this.dir, maxConcurrent: this.maxConcurrent },
      this.secret,
      this.dataDir,
    )
    const proc = spawn('aria2c', args, { detached: true, windowsHide: true, stdio: 'ignore' })
    // 关键：消费 'error' 事件。spawn 失败（ENOENT/EACCES）时 Node 会 emit 'error'，
    // 无监听器 → 抛未捕获异常 → 打崩宿主 web 进程（尸体测试见 tests/spawn-contract.test.mjs）。
    proc.on('error', (e) => { this.spawnError = describeSpawnFailure(e) })
    proc.unref()
    this.proc = proc
  }

  /** 优雅关闭 daemon（停止所有任务） */
  async shutdown(): Promise<void> {
    try { await this.rpc('aria2.shutdown') } catch { /* daemon 可能已不在 */ }
    this.proc = null
  }

  // ── 任务操作 ──
  async add(uris: string[], opts: { dir?: string; out?: string; seed?: boolean } = {}): Promise<string> {
    return await this.rpc<string>('aria2.addUri', [uris, buildAddOptions(opts)])
  }

  async active(): Promise<Aria2Task[]> {
    const list = await this.rpc<any[]>('aria2.tellActive', [])
    return (list ?? []).map((t) => mapTask(t))
  }

  async waiting(offset = 0, num = 100): Promise<Aria2Task[]> {
    const list = await this.rpc<any[]>('aria2.tellWaiting', [offset, num])
    return (list ?? []).map((t) => mapTask(t))
  }

  async stopped(offset = 0, num = 30): Promise<Aria2Task[]> {
    const list = await this.rpc<any[]>('aria2.tellStopped', [offset, num])
    return (list ?? []).map((t) => mapTask(t))
  }

  async status(gid: string): Promise<Aria2Task> {
    const t = await this.rpc<any>('aria2.tellStatus', [gid])
    if (!t) throw new Error(`任务不存在: ${gid}`)
    return mapTask(t)
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
    await this.rpc(removeRpcMethod(t.status, force), [gid])
  }

  async globalStat(): Promise<GlobalStat> {
    const s = await this.rpc<any>('aria2.getGlobalStat', [])
    return mapGlobalStat(s)
  }

  /** 设置全局限速（KB/s，<=0 = 不限） */
  async setGlobalLimit(downloadK: number, uploadK: number): Promise<void> {
    await this.rpc('aria2.changeGlobalOption', [buildLimitOptions(downloadK, uploadK)])
  }
}
