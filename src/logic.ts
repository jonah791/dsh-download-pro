/**
 * 纯逻辑层：格式化 / argv 与 RPC 载荷拼装 / 状态映射 / 错误文案——**无 IO、无子进程、无网络**。
 *
 * 从 `src/index.ts`（渲染格式化）与 `src/aria2.ts`（daemon argv、RPC 载荷、任务映射）抽出，
 * 逐条对齐原实现；副作用（spawn/fetch/fs）全部留在原处。可离线单测：`tests/logic.test.mjs`。
 */

import path from 'node:path'

/* ── 数值/标识格式化 ── */

/** 字节数人类可读：`0`/假值 → `0 B`；逐级 1024 进位；≥100 不保留小数 */
export function fmtSize(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`
}

/** 速度：`>0` 才带单位，否则 `--`（未知/停滞与 0 同形） */
export function fmtSpeed(n: number): string {
  return n > 0 ? `${fmtSize(n)}/s` : '--'
}

/** gid 截断显示：超过 8 位取前 8 位 */
export function shortGid(gid: string): string {
  return gid.length > 8 ? gid.slice(0, 8) : gid
}

/* ── 渲染行（render 用，纯字符串） ── */

/** 活跃/等待任务行 */
export function formatTaskLine(t: any): string {
  return `[${shortGid(t.gid)}] ${t.name}  ${t.status === 'complete' ? '✔ 完成' : `${t.progress}%`}  ${fmtSize(t.completedLength)}/${fmtSize(t.totalLength)}  ↓${fmtSpeed(t.downloadSpeed)}`
}

/** 已结束任务行：完成显示总大小，否则显示错误/状态 */
export function formatStoppedLine(t: any): string {
  return t.status === 'complete'
    ? `[${shortGid(t.gid)}] ${t.name}  ✔ 完成  ${fmtSize(t.totalLength)}`
    : `[${shortGid(t.gid)}] ${t.name}  ✘ ${t.errorMessage ?? t.status}`
}

/* ── 入参校验（download_add / download_control） ── */

/** 仅接受 `magnet:` 磁力链或 `http(s)://` 链接（大小写不敏感） */
export function isSupportedUrl(url: string): boolean {
  return /^(magnet:|https?:\/\/)/i.test(url)
}

export const VALID_ACTIONS = ['pause', 'resume', 'remove', 'force-remove'] as const

export function isValidAction(action: string): boolean {
  return (VALID_ACTIONS as readonly string[]).includes(action)
}

/* ── aria2 daemon argv ── */

export interface DaemonConfig {
  rpcPort: number
  dir: string
  maxConcurrent: number
}

/** daemon 启动参数（纯拼装）。
 *  关键不变量：RPC 只监听本机（`--rpc-listen-all=false`）、secret 认证、会话文件路径用正斜杠、
 *  DHT/BT 监听端口避开 Windows 排除段 6644-7043。 */
export function buildDaemonArgs(cfg: DaemonConfig, secret: string, dataDir: string): string[] {
  return [
    '--enable-rpc',
    '--rpc-listen-all=false',
    `--rpc-listen-port=${cfg.rpcPort}`,
    `--rpc-secret=${secret}`,
    `--dir=${cfg.dir}`,
    `--max-concurrent-downloads=${cfg.maxConcurrent}`,
    '--max-connection-per-server=16',
    '--split=16',
    '--min-split-size=1M',
    '--continue=true',
    '--file-allocation=none',
    '--seed-time=0',
    '--enable-dht=true',
    '--dht-listen-port=46000-47000',
    '--listen-port=46000-47000',
    '--enable-peer-exchange=true',
    '--dht-entry-point=dht.transmissionbt.com:6881',
    '--dht-entry-point=router.bittorrent.com:6881',
    '--dht-entry-point=router.utorrent.com:6881',
    '--dht-entry-point=dht.libtorrent.org:25401',
    '--bt-max-peers=300',
    `--save-session=${path.join(dataDir, 'session').replace(/\\/g, '/')}`,
    '--save-session-interval=60',
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
}

/** `aria2.addUri` 的可选参数。
 *  ⚠️ 已知缺陷（2026-09-14 证伪登记，未修）：`seed:true` 分支写入 `seed-time='0'`，
 *  而 daemon 全局已是 `--seed-time=0`（aria2 语义：0 = 下载完**停止**做种）——
 *  与参数文案「完成后继续做种」**相反**，且与不传该参数**逐字节等价 = 空操作**。 */
export function buildAddOptions(opts: { dir?: string; out?: string; seed?: boolean }): Record<string, string> {
  const options: Record<string, string> = {}
  if (opts.dir) options.dir = opts.dir
  if (opts.out) options.out = opts.out
  if (opts.seed) {
    options['seed-time'] = '0'
    options['bt-seed-unverified'] = 'true'
  }
  return options
}

/** 全局限速参数（KB/s；`<=0` = 不限） */
export function buildLimitOptions(downloadK: number, uploadK: number): Record<string, string> {
  const opts: Record<string, string> = {}
  opts['max-overall-download-limit'] = downloadK <= 0 ? '0' : `${downloadK}K`
  opts['max-overall-upload-limit'] = uploadK <= 0 ? '0' : `${uploadK}K`
  return opts
}

/* ── JSON-RPC 载荷与错误文案 ── */

/** RPC 请求体（secret 认证模式：首参固定为 `token:<secret>`，id 由调用方递增注入） */
export function buildRpcBody(method: string, params: unknown[], secret: string, id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: [`token:${secret}`, ...params],
  })
}

/** HTTP 非 2xx 时的错误文案：能从 body 取到 JSON-RPC `error.message` 就用它（更具体），
 *  否则回落 `aria2 RPC HTTP <status>`（绝不静默，也绝不因 body 不是 JSON 而抛） */
export function rpcErrorMessage(status: number, bodyText: string): string {
  let msg = `aria2 RPC HTTP ${status}`
  try {
    const d = JSON.parse(bodyText) as { error?: { message?: string } }
    if (d.error?.message) msg = `aria2: ${d.error.message}`
  } catch { /* 非 JSON body，保留 HTTP 状态信息 */ }
  return msg
}

/** JSON-RPC 200 但 body 带 `error` 时的文案 */
export function rpcBodyError(bodyText: string): string | null {
  try {
    const d = JSON.parse(bodyText) as { error?: { code: number; message: string } }
    if (d.error) return `aria2 error ${d.error.code}: ${d.error.message}`
  } catch { /* 解析失败交给调用方按原语义处理 */ }
  return null
}

/* ── 任务/全局状态映射 ── */

export interface Aria2Task {
  gid: string
  status: string
  name: string
  totalLength: number
  completedLength: number
  downloadSpeed: number
  uploadSpeed: number
  progress: number
  dir: string
  errorMessage?: string
  errorCode?: string
  numSeeders?: number
  connections?: number
  files: { path: string; length: number; completedLength: number }[]
}

/** aria2 原始任务对象 → 内部任务模型（纯映射，缺字段一律兜底，不抛） */
export function mapTask(t: any): Aria2Task {
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

export interface GlobalStat {
  downloadSpeed: number; uploadSpeed: number
  numActive: number; numWaiting: number; numStopped: number; numStoppedTotal: number
}

export function mapGlobalStat(s: any): GlobalStat {
  return {
    downloadSpeed: Number(s?.downloadSpeed ?? 0),
    uploadSpeed: Number(s?.uploadSpeed ?? 0),
    numActive: Number(s?.numActive ?? 0),
    numWaiting: Number(s?.numWaiting ?? 0),
    numStopped: Number(s?.numStopped ?? 0),
    numStoppedTotal: Number(s?.numStoppedTotal ?? 0),
  }
}

/** 移除任务时的 RPC 方法选择：已结束类任务用 `removeDownloadResult`，其余用 remove/forceRemove */
export function removeRpcMethod(status: string, force: boolean): string {
  if (status === 'complete' || status === 'removed' || status === 'error') return 'aria2.removeDownloadResult'
  return force ? 'aria2.forceRemove' : 'aria2.remove'
}

/** spawn 层失败（如 `aria2c` 不在 PATH）的文案。
 *  **必须被注册为 `'error'` 监听器消费**——不消费时 Node 会把未处理的 `'error'` 事件抛成
 *  未捕获异常（实测会打崩宿主进程），见 `tests/spawn-contract.test.mjs` 的尸体测试。 */
export function describeSpawnFailure(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null
  const code = e?.code ?? 'UNKNOWN'
  return `aria2c 启动失败（${code}）：${String(e?.message ?? code)}——请确认 aria2c 已安装并在 PATH（或修正 rpcPort 占用）`
}
