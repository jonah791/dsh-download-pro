/**
 * 子进程契约守卫（回归测试 · 尸体测试）。
 *
 * 已证实的缺陷（2026-09-14）：`src/aria2.ts:spawn()` 用 `spawn('aria2c', args, …)` 拉起 daemon，
 * 但**从未注册 `'error'` 监听器**。spawn 失败（`aria2c` 不在 PATH = ENOENT、权限 EACCES）时
 * Node 会在 ChildProcess 上 emit `'error'`——**无监听器 ⇒ 抛未捕获异常 ⇒ 打崩宿主 web 进程**。
 * 而 `apply()` 在装载时就调用 `aria2.ensure()`，即「没装 aria2c 的机器上装本插件 = web 起不来」。
 *
 * 本文件让这条缺陷不可能复发：① 用真实子进程取得「未处理 error 会崩」的尸体证据；
 * ② 静态守卫要求每个 `spawn(` 调用点必须消费 `'error'`，且 daemon 必须按生命周期契约拉起。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const FAKE_BIN = 'dsh-definitely-not-a-real-binary-xyz'

/* ── 尸体测试：用真实子进程证明「未处理 spawn error 会打崩进程」 ── */

function runNode(code) {
  return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 20000 })
}

test('尸体测试：spawn 失败且无 error 监听器 → 进程确实崩（非零退出 + ENOENT）', () => {
  const r = runNode(
    `const { spawn } = require('node:child_process');
     spawn('${FAKE_BIN}', [], { stdio: 'ignore' });
     setTimeout(() => {}, 500);`,
  )
  assert.notEqual(r.status, 0, '未处理 error 必须导致非零退出（这就是修复前的宿主崩溃形态）')
  assert.match(r.stderr, /ENOENT/, `stderr 应含 ENOENT 尸体指纹，实际：${r.stderr}`)
})

test('对照测试：同一次 spawn 失败，若注册了 error 监听器 → 进程不崩（修复形态有效）', () => {
  const r = runNode(
    `const { spawn } = require('node:child_process');
     const p = spawn('${FAKE_BIN}', [], { stdio: 'ignore' });
     p.on('error', () => { console.log('CONSUMED'); process.exit(0); });
     setTimeout(() => process.exit(2), 2000);`,
  )
  assert.equal(r.status, 0, `注册监听器后必须不崩，实际 status=${r.status} stderr=${r.stderr}`)
  assert.match(r.stdout, /CONSUMED/)
})

/* ── 静态守卫（纯扫描器，便于尸体测试复用） ── */

/** 扫描 `{文件名: 源码}`，返回违规清单：
 *  ① 每个 `spawn(` 调用点必须在随后 5 行内注册 `on('error'`；
 *  ② 每个 `spawn(` 调用点必须带 daemon 生命周期契约（detached/windowsHide/stdio:ignore + unref）。
 *  判据只认「首参为字符串字面量」的进程调用——`this.spawn()` / `private spawn(): void` 是方法自身，
 *  不是子进程调用（首版漏了这条，产生 6 条误报；判据失真比缺陷更贵）。 */
export function scanSpawnContract(sources) {
  const offenders = []
  for (const [file, src] of Object.entries(sources)) {
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*')) return
      if (!/\bspawn\s*\(\s*['"`]/.test(line)) return
      const window = lines.slice(i, i + 6).join('\n')
      if (!/\.on\(\s*'error'/.test(window)) offenders.push(`${file}:${i + 1}: spawn 未消费 'error' 事件（未捕获异常 → 宿主崩溃）`)
      if (!/detached:\s*true/.test(line)) offenders.push(`${file}:${i + 1}: daemon spawn 缺 detached:true（web 重启会杀下载）`)
      if (!/stdio:\s*'ignore'/.test(line)) offenders.push(`${file}:${i + 1}: daemon spawn 缺 stdio:'ignore'`)
      if (!/\.unref\(\)/.test(window)) offenders.push(`${file}:${i + 1}: daemon spawn 未 unref（会拖住宿主退出）`)
    })
  }
  return offenders
}

function readSources() {
  const out = {}
  for (const f of readdirSync(srcDir)) {
    if (f.endsWith('.ts')) out[f] = readFileSync(join(srcDir, f), 'utf8')
  }
  return out
}

test('尸体测试：守卫在「无 error 监听」坏样本上确实报错（否则守卫是摆设）', () => {
  const bad = { 'bad.ts': "const p = spawn('aria2c', args, { detached: true, windowsHide: true, stdio: 'ignore' })\np.unref()" }
  const offenders = scanSpawnContract(bad)
  assert.ok(offenders.some((o) => /未消费 'error'/.test(o)), `必须拦下缺监听器的样本，实际：${offenders}`)
})

test('尸体测试：守卫在完整契约样本上零误报（排除假阳性）', () => {
  const good = {
    'ok.ts': [
      "const proc = spawn('aria2c', args, { detached: true, windowsHide: true, stdio: 'ignore' })",
      "proc.on('error', (e) => { this.spawnError = e })",
      'proc.unref()',
    ].join('\n'),
  }
  assert.deepEqual(scanSpawnContract(good), [])
})

/* ── 真实源码守卫 ── */

test('真实源码：每个 spawn 调用点都消费 error 事件且满足 daemon 生命周期契约', () => {
  const offenders = scanSpawnContract(readSources())
  assert.deepEqual(offenders, [], `spawn 契约违规：\n${offenders.join('\n')}`)
})

test('真实源码：spawn 失败必须被转成可见错误（ensure 抛出），不得静默', () => {
  const src = readFileSync(join(srcDir, 'aria2.ts'), 'utf8')
  assert.match(src, /if \(this\.spawnError\) throw new Error\(this\.spawnError\)/,
    'spawn 失败必须显式抛出，由调用方 safe() 收成 {ok:false,error}')
})

test('真实源码：纯逻辑层不得含子进程/网络调用（保持可离线单测）', () => {
  const logic = readFileSync(join(srcDir, 'logic.ts'), 'utf8')
  assert.ok(!/child_process/.test(logic), 'logic.ts 不得引入 child_process')
  assert.ok(!/\bfetch\s*\(/.test(logic), 'logic.ts 不得发起网络请求')
})

test('真实源码：daemon 存活状态必须可区分「本来就活着」与「刚被拉起」（否则死亡永久不可见）', () => {
  const aria2 = readFileSync(join(srcDir, 'aria2.ts'), 'utf8')
  assert.match(aria2, /async ensure\(\): Promise<\{ started: boolean \}>/,
    'ensure 必须返回 { started }：调用方要能区分「ping 通」与「本次拉起来了」')
  const idx = readFileSync(join(srcDir, 'index.ts'), 'utf8')
  assert.match(idx, /daemonStarted: started/,
    'download_list 必须把 started 透出到输出（否则该信息在工具面不可见 = 等于没有）')
})
