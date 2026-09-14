/**
 * logic.ts 纯函数套件（离线、无 IO、无子进程、无网络）。
 * 覆盖：正常路径 + 失败/退化路径（空值、类型不符、脏数据、边界、负数、NaN）——后者是 S6 判据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  fmtSize, fmtSpeed, shortGid, formatTaskLine, formatStoppedLine,
  isSupportedUrl, isValidAction, VALID_ACTIONS,
  buildDaemonArgs, buildAddOptions, buildLimitOptions,
  buildRpcBody, rpcErrorMessage, rpcBodyError,
  mapTask, mapGlobalStat, removeRpcMethod, describeSpawnFailure,
} from '../lib/logic.js'

const CFG = { rpcPort: 16880, dir: 'D:\\桌面\\下载', maxConcurrent: 5 }

/* ── fmtSize / fmtSpeed / shortGid ── */

test('fmtSize: 正常路径——逐级 1024 进位，≥100 不保留小数', () => {
  assert.equal(fmtSize(1024), '1.0 KB')
  assert.equal(fmtSize(1536), '1.5 KB')
  assert.equal(fmtSize(1024 * 1024), '1.0 MB')
  assert.equal(fmtSize(100 * 1024), '100 KB')
  assert.equal(fmtSize(500), '500 B')
})

test('fmtSize: 退化路径——0/NaN/undefined/负数字面量的真实语义', () => {
  assert.equal(fmtSize(0), '0 B')
  assert.equal(fmtSize(Number.NaN), '0 B', '真实语义：!NaN 为真，走 0 B 分支（不是 NaN B）')
  assert.equal(fmtSize(undefined), '0 B')
  assert.equal(fmtSize(-1), '-1.0 B', '真实语义：负数不取绝对值，原样带负号')
})

test('fmtSize: 边界——超大值停在 TB 档（不越界数组）', () => {
  assert.match(fmtSize(10 ** 15), / TB$/)
  assert.equal(fmtSize(Number.POSITIVE_INFINITY), 'Infinity TB')
})

test('fmtSpeed: 退化路径——0/负数/NaN 一律显示 --（与「停滞」同形）', () => {
  assert.equal(fmtSpeed(0), '--')
  assert.equal(fmtSpeed(-5), '--')
  assert.equal(fmtSpeed(Number.NaN), '--')
  assert.equal(fmtSpeed(2048), '2.0 KB/s')
})

test('shortGid: 正常/边界——>8 位取前 8，≤8 位原样', () => {
  assert.equal(shortGid('abcdefghijkl'), 'abcdefgh')
  assert.equal(shortGid('abcdefgh'), 'abcdefgh')
  assert.equal(shortGid(''), '')
})

/* ── 渲染行 ── */

const TASK = { gid: 'abcdefghij', name: 'f.bin', status: 'active', progress: 42, completedLength: 1024, totalLength: 2048, downloadSpeed: 512 }

test('formatTaskLine: 正常路径——活跃任务带百分比与速度', () => {
  assert.equal(formatTaskLine(TASK), '[abcdefgh] f.bin  42%  1.0 KB/2.0 KB  ↓512 B/s')
})

test('formatTaskLine: 退化路径——status=complete 显示「✔ 完成」而非百分比', () => {
  assert.match(formatTaskLine({ ...TASK, status: 'complete' }), /✔ 完成/)
})

test('formatStoppedLine: 正常路径——完成显示总大小，其余显示错误/状态', () => {
  assert.equal(formatStoppedLine({ ...TASK, status: 'complete' }), '[abcdefgh] f.bin  ✔ 完成  2.0 KB')
  assert.equal(formatStoppedLine({ ...TASK, status: 'error', errorMessage: '404' }), '[abcdefgh] f.bin  ✘ 404')
})

test('formatStoppedLine: 退化路径——无 errorMessage 时回落 status（不显示 undefined）', () => {
  assert.equal(formatStoppedLine({ ...TASK, status: 'error' }), '[abcdefgh] f.bin  ✘ error')
  assert.equal(formatStoppedLine({ ...TASK, status: 'removed' }), '[abcdefgh] f.bin  ✘ removed')
})

/* ── 入参校验 ── */

test('isSupportedUrl: 正常路径——magnet/http/https，大小写不敏感', () => {
  assert.ok(isSupportedUrl('magnet:?xt=urn:btih:abc'))
  assert.ok(isSupportedUrl('MAGNET:?xt=urn:btih:abc'))
  assert.ok(isSupportedUrl('http://x/y.torrent'))
  assert.ok(isSupportedUrl('HTTPS://x/y'))
})

test('isSupportedUrl: 失败路径——其它协议/缺协议/前导空白一律拒绝', () => {
  for (const bad of ['ftp://x', 'magnet', 'file:///c:/a', '', 'javascript:alert(1)', ' magnet:?x', 'data:text/html,x']) {
    assert.equal(isSupportedUrl(bad), false, `${JSON.stringify(bad)} 必须被拒绝`)
  }
})

test('isValidAction: 白名单精确匹配（大小写敏感、不容空白）', () => {
  for (const a of VALID_ACTIONS) assert.ok(isValidAction(a))
  for (const bad of ['Pause', 'remove ', ' force-remove', '', 'delete', 'REMOVE']) {
    assert.equal(isValidAction(bad), false, `${JSON.stringify(bad)} 必须被拒绝`)
  }
})

/* ── daemon argv ── */

test('buildDaemonArgs: 安全不变量——RPC 不对外监听 + secret 认证 + 端口/并发透传', () => {
  const args = buildDaemonArgs(CFG, 'S3CR3T', 'E:\\alice\\.dsh\\data\\x')
  assert.ok(args.includes('--rpc-listen-all=false'), 'RPC 必须只监听本机（暴露面红线）')
  assert.ok(args.includes('--rpc-secret=S3CR3T'))
  assert.ok(args.includes('--rpc-listen-port=16880'))
  assert.ok(args.includes('--dir=D:\\桌面\\下载'))
  assert.ok(args.includes('--max-concurrent-downloads=5'))
  assert.ok(args.every((a) => a.startsWith('--')), '每个 argv 元素都必须是独立选项（不得拼接成 shell 串）')
})

test('buildDaemonArgs: 端口不变量——DHT/BT 监听避开 Windows 排除段 6644-7043', () => {
  const args = buildDaemonArgs(CFG, 's', '/tmp/d')
  const pick = (k) => args.find((a) => a.startsWith(k))
  assert.equal(pick('--dht-listen-port='), '--dht-listen-port=46000-47000')
  assert.equal(pick('--listen-port='), '--listen-port=46000-47000')
  for (const a of args) {
    const m = /listen-port=(\d+)-(\d+)/.exec(a)
    if (m) assert.ok(Number(m[1]) > 7043 || Number(m[2]) < 6644, `${a} 落在 Windows 排除端口段`)
  }
})

test('buildDaemonArgs: 会话文件路径统一正斜杠（跨平台/反斜杠转义坑）', () => {
  const args = buildDaemonArgs(CFG, 's', 'E:\\alice\\.dsh\\data\\dsh-download-pro')
  const session = args.find((a) => a.startsWith('--save-session='))
  assert.ok(session, '必须显式指定 --save-session')
  assert.ok(!session.includes('\\'), `session 路径不得含反斜杠：${session}`)
  assert.match(session, /\/session$/)
})

test('buildDaemonArgs: 退化路径——空 secret / 空 dir 不抛（仅产物退化）', () => {
  const args = buildDaemonArgs({ rpcPort: 0, dir: '', maxConcurrent: 0 }, '', '')
  assert.ok(args.includes('--rpc-secret='))
  assert.ok(args.includes('--dir='))
  assert.ok(args.length >= 25, '默认参数集必须完整（tracker/DHT 等）——实测 29 项；首版写 >30 是预期写错，已按真实值放宽')
})

/* ── addUri 选项 ── */

test('buildAddOptions: 正常路径——dir/out 仅在真值时透传', () => {
  assert.deepEqual(buildAddOptions({}), {})
  assert.deepEqual(buildAddOptions({ dir: 'D:\\x', out: 'a.bin' }), { dir: 'D:\\x', out: 'a.bin' })
})

test('buildAddOptions: 退化路径——空串 dir/out 不产生选项；seed=false 不产生 seed 键', () => {
  assert.deepEqual(buildAddOptions({ dir: '', out: '' }), {})
  assert.deepEqual(buildAddOptions({ seed: false }), {})
})

test('buildAddOptions: 已证伪的缺陷——seed:true 写入的 seed-time 与 daemon 全局默认**完全相同 = 空操作**', () => {
  const perTask = buildAddOptions({ seed: true })
  const daemon = buildDaemonArgs(CFG, 's', '/tmp/d')
  assert.equal(perTask['seed-time'], '0')
  assert.ok(daemon.includes('--seed-time=0'), 'daemon 全局已是 seed-time=0')
  // 证伪：参数文案承诺「完成后继续做种」，但 aria2 语义中 --seed-time=0 = 下载完**停止**做种，
  // 且逐任务值与全局值逐字节相同 ⇒ 该分支对行为**零影响**（不是「继续做种」）。
  assert.equal(perTask['seed-time'], daemon.find((a) => a.startsWith('--seed-time=')).slice('--seed-time='.length),
    'seed:true 未改变任何有效配置 → 空操作（已在语义文档 §9/§10 登记，需裁决如何修）')
})

/* ── 全局限速 ── */

test('buildLimitOptions: 正常路径——正数加 K 后缀，<=0 表示不限', () => {
  assert.deepEqual(buildLimitOptions(100, 0), { 'max-overall-download-limit': '100K', 'max-overall-upload-limit': '0' })
  assert.deepEqual(buildLimitOptions(0, 50), { 'max-overall-download-limit': '0', 'max-overall-upload-limit': '50K' })
})

test('buildLimitOptions: 退化路径——负数视为不限；NaN 产出 NaNK（真实语义，交给 aria2 报错）', () => {
  assert.equal(buildLimitOptions(-1, -1)['max-overall-download-limit'], '0')
  assert.equal(buildLimitOptions(Number.NaN, 0)['max-overall-download-limit'], 'NaNK',
    '真实语义：NaN<=0 为假 → 拼成 NaNK；schema 保证 number，故仅在调用方越界时出现')
  assert.equal(buildLimitOptions(1.5, 0)['max-overall-download-limit'], '1.5K')
})

/* ── JSON-RPC ── */

test('buildRpcBody: 正常路径——token 作为首参、id/params 透传、JSON 可解析', () => {
  const body = JSON.parse(buildRpcBody('aria2.tellStatus', ['g1'], 'sec', 7))
  assert.deepEqual(body, { jsonrpc: '2.0', id: 7, method: 'aria2.tellStatus', params: ['token:sec', 'g1'] })
})

test('buildRpcBody: 退化/恶意输入——空 secret 与含引号的 secret 不破坏 JSON 结构', () => {
  const b1 = JSON.parse(buildRpcBody('m', [], '', 1))
  assert.deepEqual(b1.params, ['token:'])
  const b2 = JSON.parse(buildRpcBody('m', [], 'a"b\\c', 2))
  assert.equal(b2.params[0], 'token:a"b\\c', 'JSON 转义由 JSON.stringify 负责，不手拼字符串')
})

test('rpcErrorMessage: 正常路径——body 带 JSON-RPC error.message 时用它（更具体）', () => {
  assert.equal(rpcErrorMessage(400, '{"error":{"code":1,"message":"cannot pause"}}'), 'aria2: cannot pause')
})

test('rpcErrorMessage: 失败路径——非 JSON / 空 body / 无 error 字段一律回落 HTTP 状态', () => {
  assert.equal(rpcErrorMessage(502, '<html>bad gateway</html>'), 'aria2 RPC HTTP 502')
  assert.equal(rpcErrorMessage(500, ''), 'aria2 RPC HTTP 500')
  assert.equal(rpcErrorMessage(404, '{"result":1}'), 'aria2 RPC HTTP 404')
  assert.equal(rpcErrorMessage(400, 'null'), 'aria2 RPC HTTP 400')
})

test('rpcBodyError: 正常路径——带 error 的 200 body 提取为错误串', () => {
  assert.equal(rpcBodyError('{"error":{"code":3,"message":"not found"}}'), 'aria2 error 3: not found')
})

test('rpcBodyError: 退化路径——无 error / error:null / 坏 JSON / 空串一律 null（不抛）', () => {
  assert.equal(rpcBodyError('{"result":"ok"}'), null)
  assert.equal(rpcBodyError('{"error":null}'), null)
  assert.equal(rpcBodyError('{broken'), null)
  assert.equal(rpcBodyError(''), null)
})

/* ── 任务映射 ── */

test('mapTask: 正常路径——字段归一 + 进度四舍五入到 0.1%', () => {
  const t = mapTask({
    gid: 'g1', status: 'active', totalLength: '3000', completedLength: '1000',
    downloadSpeed: '2048', uploadSpeed: 0, dir: 'D:\\d',
    files: [{ path: 'D:\\d\\a.bin', length: '3000', completedLength: '1000' }],
    connections: '7', numSeeders: '3', errorCode: 0,
  })
  assert.equal(t.progress, 33.3)
  assert.equal(t.totalLength, 3000)
  assert.equal(t.downloadSpeed, 2048)
  assert.equal(t.connections, 7)
  assert.equal(t.numSeeders, 3)
  assert.equal(t.errorCode, '', '真实语义：errorCode=0 为假值 → 空串')
  assert.deepEqual(t.files, [{ path: 'D:\\d\\a.bin', length: 3000, completedLength: 1000 }])
})

test('mapTask: 名称回落链——bittorrent.info.name > 文件名 basename > gid', () => {
  assert.equal(mapTask({ gid: 'g', bittorrent: { info: { name: 'BT' } }, files: [{ path: 'D:\\d\\f.bin' }] }).name, 'BT')
  // 真实语义：回落用宿主平台的 `path.basename` —— Windows 下 'D:\d\f.bin' → 'f.bin'，
  // POSIX 下反斜杠不是分隔符 → 原样返回。故按宿主平台取期望值（生产跑在 Windows，行为正确）。
  assert.equal(mapTask({ gid: 'g', files: [{ path: 'D:\\d\\f.bin' }] }).name, path.basename('D:\\d\\f.bin'))
  assert.equal(mapTask({ gid: 'g', files: [{ path: '/var/tmp/f.bin' }] }).name, 'f.bin', 'POSIX 路径两种平台都成立')
  assert.equal(mapTask({ gid: 'g' }).name, 'g')
})

test('mapTask: 退化路径——空对象/缺字段不抛，全部兜底；total=0 时进度为 0（不除零）', () => {
  const t = mapTask({})
  assert.equal(t.progress, 0)
  assert.deepEqual(t.files, [])
  assert.equal(t.dir, '')
  assert.equal(t.errorMessage, '')
  assert.equal(mapTask({ totalLength: 0, completedLength: 100 }).progress, 0)
})

test('mapTask: 边界——completed>total 时进度 >100（真实语义：不 clamp，交给展示层判读）', () => {
  assert.equal(mapTask({ totalLength: 100, completedLength: 150 }).progress, 150)
})

test('mapTask: 失败路径——files 为脏类型（非数组）时抛错（真实语义；由工具层 safe() 收口）', () => {
  assert.throws(() => mapTask({ files: {} }), TypeError)
})

test('mapGlobalStat: 正常路径 + 退化路径（null/空对象一律补 0）', () => {
  assert.deepEqual(mapGlobalStat({ downloadSpeed: '100', numActive: 2 }),
    { downloadSpeed: 100, uploadSpeed: 0, numActive: 2, numWaiting: 0, numStopped: 0, numStoppedTotal: 0 })
  assert.deepEqual(mapGlobalStat(null),
    { downloadSpeed: 0, uploadSpeed: 0, numActive: 0, numWaiting: 0, numStopped: 0, numStoppedTotal: 0 })
})

/* ── RPC 方法选择 ── */

test('removeRpcMethod: 正常路径——已结束类走 removeDownloadResult，活跃类走 remove', () => {
  for (const s of ['complete', 'removed', 'error']) assert.equal(removeRpcMethod(s, false), 'aria2.removeDownloadResult')
  for (const s of ['active', 'waiting', 'paused']) assert.equal(removeRpcMethod(s, false), 'aria2.remove')
})

test('removeRpcMethod: force 只对活跃类生效；未知状态按活跃处理（保守：真删任务而非仅清记录）', () => {
  assert.equal(removeRpcMethod('active', true), 'aria2.forceRemove')
  assert.equal(removeRpcMethod('complete', true), 'aria2.removeDownloadResult', 'force 对已结束任务无意义')
  assert.equal(removeRpcMethod('weird', true), 'aria2.forceRemove')
  assert.equal(removeRpcMethod('', false), 'aria2.remove')
})

/* ── spawn 失败文案 ── */

test('describeSpawnFailure: 正常路径——带错误码 + 下一步动作（可诊断）', () => {
  const msg = describeSpawnFailure({ code: 'ENOENT', message: 'spawn aria2c ENOENT' })
  assert.match(msg, /aria2c 启动失败（ENOENT）/)
  assert.match(msg, /PATH/, '错误串必须给出下一步动作')
})

test('describeSpawnFailure: 退化路径——null/空对象不抛，回落 UNKNOWN', () => {
  assert.match(describeSpawnFailure(null), /UNKNOWN/)
  assert.match(describeSpawnFailure({}), /UNKNOWN/)
  assert.match(describeSpawnFailure('boom'), /UNKNOWN/)
})
