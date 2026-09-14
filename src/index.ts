/** dsh-download-pro：资源下载插件 · aria2 RPC 引擎
 *  工具面：download_add（磁力/直链/种子）· download_list · download_status
 *         · download_control（暂停/恢复/移除）· download_global（统计/限速）
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Aria2Client } from './aria2.js'
import {
  fmtSize, fmtSpeed, shortGid, formatTaskLine, formatStoppedLine, isSupportedUrl, isValidAction,
} from './logic.js'

export const name = 'dsh-download-pro'
export const inject = ['tools'] as const

export interface Config {
  enabled: boolean
  rpcPort: number
  dir: string
  maxConcurrent: number
  rpcSecret: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  rpcPort: z.number().default(16880),
  dir: z.string().default('D:\\桌面\\下载'),
  maxConcurrent: z.number().default(5),
  rpcSecret: z.string().default(''),
})

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('download-pro')
  const dataDir = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'data', name)
  const aria2 = new Aria2Client({
    rpcPort: config.rpcPort,
    dir: config.dir,
    maxConcurrent: config.maxConcurrent,
    rpcSecret: config.rpcSecret,
  }, dataDir)

  const reg = (tool: any) => ctx.tools.register(defineTool(tool as any))
  const safe = async <T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    try { return { ok: true, value: await fn() } }
    catch (e: any) { return { ok: false, error: String(e?.message ?? e) } }
  }

  const baseProps: Record<string, any> = {
    ok: { type: 'boolean', required: true },
    error: { type: 'string' },
    note: { type: 'string' },
  }

  /* ── 1 · download_add：添加任务 ── */
  reg({
    name: 'download_add',
    description: '添加下载任务到 aria2 引擎：magnet: 磁力链 / http(s):// 直链 / .torrent 种子链接。返回 gid 用于后续查询与控制。磁力链需 DHT 解析，解析+开始下载可能需 10-60 秒。',
    parameters: {
      url: { type: 'string', required: true, description: '下载地址：magnet:?xt=urn:btih:... 磁力链 或 http(s):// 直链或种子链接' },
      dir: { type: 'string', description: '覆盖默认下载目录（默认 D:\\桌面\\下载）' },
      name: { type: 'string', description: '重命名（仅 HTTP 直链生效；磁力/BT 用种子内名称）' },
      seed: { type: 'boolean', description: '完成后继续做种（默认 false=下载完即停）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ...baseProps, gid: { type: 'string' }, name: { type: 'string' }, status: { type: 'string' }, dir: { type: 'string' } },
      },
      render: (_a: any, v: any) => {
        if (!v.ok) return [{ type: 'text', text: v.error ?? '添加失败' }]
        return [{ type: 'text', text: `✅ 已添加任务 [${v.gid}]\n文件: ${v.name}\n状态: ${v.status}\n目录: ${v.dir}` }]
      },
    },
    async execute(args: any) {
      const url = String(args.url ?? '').trim()
      if (!url) return { ok: false, error: 'url 必填' }
      if (!isSupportedUrl(url)) return { ok: false, error: 'url 必须是 magnet: 磁力链或 http(s):// 链接' }
      const r = await safe(async () => {
        await aria2.ensure()
        const opts: any = {}
        if (args.dir) opts.dir = String(args.dir)
        if (args.name) opts.out = String(args.name)
        if (args.seed) opts.seed = true
        const gid = await aria2.add([url], opts)
        const t = await aria2.status(gid)
        return { gid, name: t.name, status: t.status, dir: t.dir || String(args.dir ?? '') || config.dir }
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, ...r.value }
    },
  })

  /* ── 2 · download_list：任务列表 ── */
  reg({
    name: 'download_list',
    description: '列出 aria2 全部任务：活跃（下载中）/等待/已结束（含错误）。每项含 gid/文件名/进度/速度/大小。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...baseProps,
          active: { type: 'array', items: { type: 'object', additionalProperties: true } },
          waiting: { type: 'array', items: { type: 'object', additionalProperties: true } },
          stopped: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_a: any, v: any) => {
        if (!v.ok) return [{ type: 'text', text: v.error ?? '查询失败' }]
        const lines: string[] = []
        const fmtTask = formatTaskLine
        const act = (v.active ?? []).map(fmtTask)
        const wait = (v.waiting ?? []).map(fmtTask)
        const stop = (v.stopped ?? []).map(formatStoppedLine)
        if (act.length) lines.push('▼ 下载中', ...act.map((s: string, i: number) => `  ${i + 1}. ${s}`))
        if (wait.length) lines.push('▼ 等待', ...wait.map((s: string, i: number) => `  ${i + 1}. ${s}`))
        if (stop.length) lines.push('▼ 已结束', ...stop.map((s: string, i: number) => `  ${i + 1}. ${s}`))
        if (!lines.length) return [{ type: 'text', text: '当前无任务' }]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const r = await safe(async () => {
        await aria2.ensure()
        const [active, waiting, stopped] = await Promise.all([aria2.active(), aria2.waiting(), aria2.stopped()])
        return { active, waiting, stopped }
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, ...r.value }
    },
  })

  /* ── 3 · download_status：单任务详情 ── */
  reg({
    name: 'download_status',
    description: '查看单个下载任务详情：进度/速度/连接数/BT 做种数/文件列表/错误信息。',
    parameters: {
      gid: { type: 'string', required: true, description: '任务 gid（来自 download_add/download_list）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...baseProps,
          task: { type: 'object', additionalProperties: true },
          files: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_a: any, v: any) => {
        if (!v.ok) return [{ type: 'text', text: v.error ?? '查询失败' }]
        const t = v.task
        if (!t) return [{ type: 'text', text: '任务不存在' }]
        const lines = [
          `任务 [${t.gid}] · ${t.name}`,
          `状态: ${t.status}${t.errorMessage ? ` · 错误: ${t.errorMessage}（${t.errorCode}）` : ''}`,
          `进度: ${t.progress}%  ${fmtSize(t.completedLength)} / ${fmtSize(t.totalLength)}`,
          `速度: ↓${fmtSpeed(t.downloadSpeed)}  ↑${fmtSpeed(t.uploadSpeed)}`,
          `连接: ${t.connections ?? '-'} 个${t.numSeeders != null ? ` · BT 做种 ${t.numSeeders}` : ''}`,
          `目录: ${t.dir}`,
        ]
        const files = (v.files ?? []).map((f: any, i: number) => `  ${i + 1}. ${f.path} (${fmtSize(f.length)})`)
        if (files.length) lines.push('文件:', ...files)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: any) {
      const gid = String(args.gid ?? '').trim()
      if (!gid) return { ok: false, error: 'gid 必填' }
      const r = await safe(async () => {
        await aria2.ensure()
        const t = await aria2.status(gid)
        return { task: t, files: t.files }
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, ...r.value }
    },
  })

  /* ── 4 · download_control：暂停/恢复/移除 ── */
  reg({
    name: 'download_control',
    description: '控制下载任务：pause=暂停 / resume=恢复 / remove=移除任务 / force-remove=强制移除。remove 时可带 removeFiles=true 同时删除已下载文件。',
    parameters: {
      gid: { type: 'string', required: true, description: '任务 gid' },
      action: { type: 'string', enum: ['pause', 'resume', 'remove', 'force-remove'], required: true, description: '操作' },
      removeFiles: { type: 'boolean', description: '仅 remove/force-remove 时生效：同时删除已下载文件（默认 false）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ...baseProps, gid: { type: 'string' }, action: { type: 'string' }, removedFiles: { type: 'array', items: { type: 'string' } } },
      },
      render: (_a: any, v: any) => {
        if (!v.ok) return [{ type: 'text', text: v.error ?? '操作失败' }]
        if (v.note) return [{ type: 'text', text: v.note }]
        const extra = (v.removedFiles?.length ?? 0) > 0 ? `\n已删除文件: ${v.removedFiles.join(', ')}` : ''
        return [{ type: 'text', text: `已${v.action} 任务 [${v.gid}]${extra}` }]
      },
    },
    async execute(args: any) {
      const gid = String(args.gid ?? '').trim()
      const action = String(args.action ?? '')
      if (!gid) return { ok: false, error: 'gid 必填' }
      if (!isValidAction(action)) return { ok: false, error: 'action 必须是 pause/resume/remove/force-remove' }
      const r = await safe(async () => {
        await aria2.ensure()
        // pause/resume 前检查状态，对已结束任务给友好提示（aria2 会对 complete 任务 pause 报 400）
        if (action === 'pause' || action === 'resume') {
          const t = await aria2.status(gid)
          if (t.status === 'complete' || t.status === 'removed') {
            return { gid, action, note: `任务已${t.status === 'complete' ? '完成' : '移除'}，无需操作` }
          }
          if (action === 'pause' && t.status === 'paused') return { gid, action, note: '任务已在暂停状态' }
          if (action === 'resume' && t.status === 'active') return { gid, action, note: '任务已在下载中' }
        }
        if (action === 'pause') { await aria2.pause(gid); return { gid, action } }
        if (action === 'resume') { await aria2.resume(gid); return { gid, action } }
        const force = action === 'force-remove'
        let removedFiles: string[] = []
        if (args.removeFiles) {
          try {
            const t = await aria2.status(gid)
            removedFiles = t.files.map((f) => f.path).filter((p) => p)
          } catch { /* 任务已不在，忽略 */ }
        }
        await aria2.remove(gid, force)
        if (args.removeFiles) {
          for (const p of removedFiles) {
            try { if (existsSync(p)) rmSync(p, { force: true, recursive: true }) } catch { /* 忽略单个删除失败 */ }
          }
          // BT 任务下载目录若已空则一并删除
          try {
            const dir = removedFiles[0] ? path.dirname(removedFiles[0]) : ''
            if (dir && existsSync(dir)) {
              const entries = readdirSync(dir)
              if (entries.length === 0) rmSync(dir, { force: true, recursive: true })
            }
          } catch { /* 忽略 */ }
        }
        return { gid, action, removedFiles }
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, ...r.value }
    },
  })

  /* ── 5 · download_global：全局统计 + 限速 ── */
  reg({
    name: 'download_global',
    description: '全局下载状态：总速度/活跃/等待/已结束任务数。可选设置全局限速（downloadLimit/uploadLimit，KB/s，0=不限，缺省不改动）。',
    parameters: {
      downloadLimit: { type: 'number', description: '全局下载限速 KB/s（0=不限）' },
      uploadLimit: { type: 'number', description: '全局上传限速 KB/s（0=不限）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...baseProps,
          stat: { type: 'object', additionalProperties: true },
          limitApplied: { type: 'boolean' },
        },
      },
      render: (_a: any, v: any) => {
        if (!v.ok) return [{ type: 'text', text: v.error ?? '查询失败' }]
        const s = v.stat ?? {}
        const limitNote = v.limitApplied ? '\n(已应用限速设置)' : ''
        return [{ type: 'text', text: `全局下载: ↓${fmtSpeed(s.downloadSpeed)}  ↑${fmtSpeed(s.uploadSpeed)}\n活跃 ${s.numActive} · 等待 ${s.numWaiting} · 已结束 ${s.numStoppedTotal}${limitNote}` }]
      },
    },
    async execute(args: any) {
      const r = await safe(async () => {
        await aria2.ensure()
        let limitApplied = false
        if (args.downloadLimit != null || args.uploadLimit != null) {
          await aria2.setGlobalLimit(Number(args.downloadLimit ?? 0), Number(args.uploadLimit ?? 0))
          limitApplied = true
        }
        const stat = await aria2.globalStat()
        return { stat, limitApplied }
      })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, ...r.value }
    },
  })

  // ── 生命周期：web 启动时确保 daemon。注意：dispose 不关闭 daemon——
  //    daemon 是 detached 常驻进程，必须跨 web 重启存活（否则重启即中断所有下载任务）。
  //    彻底关闭需显式调用 aria2.shutdown RPC 或 taskkill。
  if (config.enabled) {
    aria2.ensure().then(() => logger.info('aria2 daemon 就绪')).catch((e) => logger.warn(`aria2 daemon 启动失败: ${e?.message ?? e}`))
  }
}
