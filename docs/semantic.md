# 语义文档：dsh-download-pro（aria2 下载引擎操控面）

| 项 | 值 |
|----|----|
| 能力名 | dsh-download-pro（插件内 `name = 'dsh-download-pro'`；组合行 id `agent-download-pro`） |
| 主副本路径 | `self-plugins/dsh-download-pro/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-download-pro/src/index.ts`（工具面）、`self-plugins/dsh-download-pro/src/aria2.ts`（RPC 客户端 + daemon 管理） |
| 版本 | v0.1.1（package.json） |
| 状态 | **draft**（补课文档，验收条目待线上复核） |
| 依赖服务 | `inject = ['tools']` |
| 外部依赖 | `aria2c` 可执行文件（detached 常驻进程）+ 本地 TCP 端口 `rpcPort`（默认 16880） |

---

## 1 · 定位与反定位

**定位**：给模型一个**常驻的 aria2 下载引擎**（磁力 / BT / HTTP(S) 直链 / `.torrent`），并暴露 5 个工具
完成「添加 → 观察 → 控制 → 限速」闭环；daemon 以 detached 进程存活，**web 重启不中断下载**。

**反定位（本文不管什么）**：
- 不管搜索与资源发现（那属于 `dsh-search-pro` 与技能 `search-resource-freshness`）——本插件拿到 URL 之后的**执行**环节
- 不管文件内容识别/整理（下载完就是文件，落在 `dir` 里）
- 不管 aria2c 的安装（README 明示 scoop/choco 自装；插件只 spawn）
- **不是** 网盘客户端（不走百度/夸克 SDK），**不是** 浏览器下载管理器（无 UI、无右键集成）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| gid | aria2 任务标识，`download_add` 返回，后续 `status`/`control` 的句柄 |
| daemon | 独立 detach 的 `aria2c` 进程；**生命周期独立于 web**（设计核心） |
| token | RPC 认证串；RPC 参数首项恒为 `token:<secret>` |
| ensure() | 「ping 不通就 spawn 并等就绪（40×500ms ≈ 20s）」的幂等前置动作，**每个工具调用前都执行** |
| 端口隔离 | RPC 16880、BT/DHT 46000-47000 —— 全部避开 Windows 排除端口段 6644-7043 |
| stopped 分流 | 已结束任务走 `removeDownloadResult`，活动任务走 `remove/forceRemove` |

## 3 · 概念模型

```
模型（爱丽丝）
  │  download_add / download_list / download_status / download_control / download_global
  ▼
src/index.ts  apply(ctx, config)
  ├─ dataDir = ($DSH_HOME ?? ~/.dsh)/data/dsh-download-pro
  ├─ new Aria2Client({rpcPort,dir,maxConcurrent,rpcSecret}, dataDir)
  ├─ safe(fn)  ← 每个工具体包一层：异常 → {ok:false,error}（永不抛出）
  └─ if (config.enabled) aria2.ensure()   ← web 启动即确保 daemon

src/aria2.ts  Aria2Client
  ├─ loadOrCreateSecret()  读/写 <dataDir>/token（16 字节 hex；写失败仅本次有效）
  ├─ rpc(method, params)   POST http://127.0.0.1:<rpcPort>/jsonrpc，params[0]='token:<secret>'
  │                        AbortSignal.timeout(15000)；HTTP 4xx → 提取 JSON-RPC error.message 抛出
  ├─ ensure() → ping(aria2.getVersion) 失败则 spawn() → 轮询 40×500ms → 超时抛错
  └─ spawn()  spawn('aria2c', [...args], {detached:true, stdio:'ignore'}) + unref()

磁盘产物：<dataDir>/token（凭据）· <dataDir>/session（aria2 任务会话，--save-session-interval=60）
下载落点：config.dir（默认 D:\桌面\下载）
```

不变量（invariants）：
1. **I1 RPC 只回环**：`--rpc-listen-all=false` + 客户端恒连 `127.0.0.1`——不可被局域网访问（可 `netstat -ano | findstr :16880` 验证只 LISTEN 127.0.0.1）。
2. **I2 每个工具调用前都 `ensure()`**：`grep -c "aria2.ensure()" src/index.ts` = 6（5 个工具各 1 + apply 内 1）。
3. **I3 disconnect 不杀 daemon**：`apply` 的清理**不**调用 `shutdown()`——源码注释明示「否则重启即中断所有下载任务」。
4. **I4 无裸抛**：所有工具体经 `safe()`；`ping()` 内部吞错返回 bool；`shutdown()` 吞错。
5. **I5 端口不落陷阱区**：`rpcPort` 默认 16880、BT/DHT 46000-47000，均不在 6644-7043。

## 4 · 契约

### 4.1 配置（`Config` schema）
| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | **被消费**：`apply` 末尾 `if (config.enabled) aria2.ensure()` |
| `rpcPort` | `16880` | RPC 端口（不可用 6800：Windows 排除段） |
| `dir` | `D:\桌面\下载` | 默认下载目录（`--dir`） |
| `maxConcurrent` | `5` | 最大并发数（`--max-concurrent-downloads`） |
| `rpcSecret` | `''` | 空 = 自动生成并持久化到 `<dataDir>/token` |
| `seedTimeMinutes` | `1440` | **被消费**：`download_add seed:true` 时的做种分钟数（单任务 `seed-time`，覆盖 daemon 全局值）。**必须 >0**——aria2 里 `--seed-time=0` = **停止**做种，故 0 属反义值，非法输入（0/负/NaN/Infinity/非数）一律回落默认 |

### 4.2 落盘契约
| 路径 | 形状 | 写入方式 / 读取语义 |
|------|------|-------------------|
| `<DSH_HOME>/data/dsh-download-pro/token` | 单行 hex 串 | `writeFileSync` 覆盖写；启动时读，非空即用；读失败则重新生成（**不删旧文件**） |
| `<DSH_HOME>/data/dsh-download-pro/session` | aria2 会话文件 | 由 aria2c 自身按 60s 间隔写；用于跨重启恢复任务 |
| `config.dir`（默认 `D:\桌面\下载`） | 下载产物 | aria2c 自身写；`download_control remove+removeFiles` 时插件会 `rmSync` 删除 |

### 4.3 状态→裁决表
| 输入状态 | 裁决 | 依据 |
|---------|------|------|
| `url` 不匹配 `^(magnet:\|https?://)` | `ok:false, error:'url 必须是 magnet: 磁力链或 http(s):// 链接'` | 输入前置校验 |
| `ensure()` 20s 内未就绪 | `ok:false` + `aria2 守护进程启动超时（20s）` | 超时即失败，不静默 |
| `action='pause'` 且任务 `complete/removed` | `ok:true` + `note:'任务已完成/移除，无需操作'`（**不调 RPC**） | 规避 aria2 HTTP 400 |
| `action='pause'` 且已 `paused` / `resume` 且已 `active` | `ok:true` + `note:'任务已…'`（**不调 RPC**） | 幂等短路 |
| `remove` 且任务 `complete/removed/error` | `aria2.removeDownloadResult` | aria2 语义分流 |
| `remove` 且任务活动/等待/暂停 | `aria2.remove` / `aria2.forceRemove` | 同上 |
| `removeFiles=true` | 先取 `files[].path` → remove → 逐个 `rmSync(force,recursive)` → 若父目录已空则删父目录 | 删目录仅当为空（防误删） |
| `downloadLimit/uploadLimit` 均缺省 | `limitApplied:false`，只读统计 | 读路径不改状态 |
| 任一参数 `<=0` 进限速 | 发送 `'0'` = 不限速 | aria2 语义 |

### 4.4 调用点清单 `[MUST]`
| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml` 行 `id: agent-download-pro` / `name: dsh-download-pro`（无 config） | web 启动挂载 |
| 插件本体 | `src/index.ts:apply` → `reg({name:'download_add'…})` / `'download_list'` / `'download_status'` / `'download_control'` / `'download_global'`（经局部 `reg = defineTool + ctx.tools.register`） | 挂载时注册 |
| 插件本体 | `src/index.ts:apply` 末尾 → `if (config.enabled) aria2.ensure()` | web 启动即预热 daemon |
| 5 个工具 | `src/index.ts:execute` → `safe(async () => { await aria2.ensure(); … })` | 每次调用 |
| 全部 RPC | `src/aria2.ts:rpc()` → `POST http://127.0.0.1:${rpcPort}/jsonrpc`，methods：`aria2.getVersion` / `addUri` / `tellActive` / `tellWaiting` / `tellStopped` / `tellStatus` / `pause` / `unpause` / `remove` / `forceRemove` / `removeDownloadResult` / `getGlobalStat` / `changeGlobalOption` / `shutdown` | 按需 |
| daemon 启动 | `src/aria2.ts:spawn()` → `spawn('aria2c', [...], {detached:true, stdio:'ignore'})` | ping 失败时 |
| 凭据 | `src/aria2.ts:loadOrCreateSecret()` → `<dataDir>/token` | 构造 `Aria2Client` 时 |
| 模型（爱丽丝） | 下载主链：`download_add` → `download_list`/`download_status` → `download_control` | 资源获取 |

## 5 · 边界与信任

- 能力边界 ≠ 沙箱：本插件能写入 `dir`、能 `rmSync(recursive)` 删除已下载文件与**其空的父目录**。删除面（destructive）是真实风险点——因此 `removeFiles` 默认 `false`，且只在显式传参时生效。
- 不越界清单：不搜索资源；不解析种子内容；不上传（除 BT 做种：**默认关闭**，仅当 `download_add seed:true` 时按 `seedTimeMinutes` 做种）；不暴露 RPC 到局域网；不写 `dir` 之外的路径（除 `dataDir`）。
- 失败面：
  - RPC 失败 → `rpc()` 抛 `aria2: <message>` 或 `aria2 error <code>: <message>` → `safe()` 转 `{ok:false,error}`（**放行 + 报错**）。
  - 凭据写失败 → 注释明示「不致命，仅本次会话有效」，**不阻塞**。
  - `removeFiles` 单文件删除失败 → `catch {}` 忽略（其余文件继续删）——注意：此处是**静默**，与「不许静默」纪律相抵，见 §10 U3。

## 6 · 与既有机制的关系

- 与 **AGENTS.md §5.19（单点所有权）**：本插件是 **aria2 daemon 的唯一 owner**（唯一 spawn 者）；web 重启**不**释放它——重启期间所有权是「空窗」而非「转移」，需注意未来若出现第二个 spawn 者即成双 owner。
- 与 **§5.10（预防性存活）**：daemon 不在 web 生命周期内，故 web 崩溃不影响下载；但也没有守护者替它保活（`ensure()` 是**每次调用时的补救**而非周期巡检）。
- 与 **§5.11（组合变更必验证）**：改代码 → `pnpm build` → 预检须看到 `lib/index.js` mtime 前进。
- 与 `dsh-search-pro`：搜索（发现）→ 本插件（下载）是前后工序。
- 与 **daemon_restart**：重启 web 会重新 `ensure()`，daemon 已在则 ping 通过直接复用（**不重启下载**）。

**生效判据（改代码后怎么证明真的生效）**：
1. 构建产物新：`self-plugins/dsh-download-pro/lib/index.js` + `lib/aria2.js` 的 mtime **晚于**当前 web 进程启动时间。
2. 工具面在场：本会话能列出 `download_add/list/status/control/global` 五个工具。
3. 行为可答：`download_global` 返回真实统计（`numActive/numWaiting/numStoppedTotal`），而非 `{ok:false}`。
4. 落盘产物：`<DSH_HOME>/data/dsh-download-pro/token` 存在且非空；daemon 在 `netstat -ano | findstr :16880` 中 LISTEN；`<dataDir>/session` 每 60s 被刷新（mtime 前进 = daemon 活着）。
5. 反证：`ping` 通但 `aria2.getVersion` 返回的版本与 `aria2c --version` 不一致 ⇒ 你连上的是**另一个** aria2 实例（端口冲突），不是本插件拉起的。

**回退**：`git revert` 最近提交 → `pnpm build` → 预检 → 哨兵重启 web。
**数据面回退**：daemon 不停（可继续下载）；若要彻底停止 engine，需显式 `aria2.shutdown` RPC 或 `taskkill /IM aria2c.exe`（本插件**不提供** `download_shutdown` 工具——这是刻意的：防止一次误调用中断全部下载）。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰好 5 个 `download_*` | `grep -c "name: 'download_" src/index.ts` = 5 | 待验收 |
| A2 | 每个工具调用前 ensure | `grep -c "aria2.ensure()" src/index.ts` = 6 | 待验收 |
| A3 | RPC 只回环 | `netstat -ano \| findstr :16880` 只出现 `127.0.0.1:16880` | 待验收 |
| A4 | 凭据持久化 | 删 `token` → 调 `download_global`（重新生成）→ 重启 web → token 内容不变 | 待验收 |
| A5 | web 重启不中断下载 | 加一个大磁力任务 → `daemon_restart` → `download_list` 显示同一 gid 仍在 active，进度不回退 | 待验收 |
| A6 | pause 已完成任务不报错 | 对 `complete` gid 调 `download_control action=pause` → `ok:true` + `note` 含「已完成」 | 待验收 |
| A7 | removeFiles 删文件且只删空目录 | 造一个单文件任务 → `remove+removeFiles=true` → 文件消失；若目录内另有他文件则目录保留 | 待验收 |
| A8 | 非法 url 被拒 | `download_add url=ftp://x` → `ok:false` 且 error 明示 `magnet:`/`http(s)://` | 待验收 |
| A9 | 限速 0 = 不限 | `download_global downloadLimit=0` → aria2 返回该任务 `max-overall-download-limit:0` | 待验收（需 RPC 直查） |
| A10 | spawn 失败不再打崩宿主（未处理 `'error'` 事件） | `npm test` → `tests/spawn-contract.test.mjs`：**尸体测试**用真实子进程证明「spawn 失败 + 无监听器 = 非零退出 + ENOENT」，对照测试证明「注册监听器 = 不崩」；静态守卫要求每个 `spawn('…'` 调用点消费 `'error'` | **已实测（2026-09-14，44/44 pass）** |
| A11 | daemon argv 的安全与生命周期不变量 | `npm test` → `tests/logic.test.mjs:buildDaemonArgs`：`--rpc-listen-all=false` 必在、secret 透传、DHT/BT 监听端口不在 Windows 排除段 6644-7043、`--save-session` 路径**不含反斜杠**、每个 argv 元素独立（不拼 shell 串） | **已实测（2026-09-14）** |
| A12 | 纯逻辑有失败/退化路径覆盖 | `npm test` → `tests/logic.test.mjs` 30 例：0/NaN/负数/Infinity 格式化、脏类型（`files:{}`）、缺字段、空 secret、`errorCode=0`、未知 action、非 JSON RPC body 等 | **已实测（2026-09-14）** |
| A13 | **已修（2026-09-15）**：`seed=true` 写正做种分钟数，必须与 daemon 全局 `--seed-time=0` **不同**（修复前二者逐字节相同 = 空操作） | `npm test` → `buildAddOptions({seed:true})['seed-time'] === String(DEFAULT_SEED_MINUTES)` 且 `!==` daemon 全局值；非法 `seedTimeMinutes` 回落默认 | **已实测（2026-09-15）** |
| A14 | `logic.ts` 保持纯逻辑（可离线单测） | `npm test` → 断言 `src/logic.ts` 不含 `child_process`、不含 `fetch(` | **已实测（2026-09-14）** |
| A15 | **daemon 死亡可见**（2026-09-15 新增）：`download_list` 区分「本来就活着」与「本次刚被拉起」 | 源码级守卫断言 `aria2.ts:ensure` 返回 `{started}` 且 `index.ts` 把 `daemonStarted: started` 透出到输出；线上调用返回 `daemonStarted:false`（daemon 常驻） | **已实测（2026-09-15）** |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（工具面 + `safe()` + 删除逻辑）、`src/aria2.ts`（RPC 客户端 + daemon 管理 + 进程生命周期）、`src/logic.ts`（**纯逻辑层**：格式化/argv 拼装/RPC 载荷/任务映射/错误文案）。
- 同语义副本：无。aria2 自身的 `--option` 语义不在本文管辖。
- 未实现/未验证部分**显式标注**：
  - **单测（2026-09-14 补课已补）**：`tests/logic.test.mjs`（30）+ `tests/spawn-contract.test.mjs`（14）= **44/44 全过**；`npm test` 一条命令可复跑。A1–A9 仍需**真实 aria2 daemon** 的线上验收（离线单测不能替代）。
  - `spawn()` 的 29 条 aria2 参数（BT tracker 列表、DHT entry point、`--bt-max-peers=300`、`--split=16` …）是**经验值**：其**拼装正确性**现已被单测锁住（A11），但**效果**只能由实际下载成功率观察（属「经验参数」而非契约）。
  - ~~工具 `download_add` 的 `seed=true` 分支写 `options['seed-time']='0'`，而 spawn 全局已含 `--seed-time=0`——**已由单测证伪为「空操作」**（不是「做种」也不是「相反」，而是**零影响**），见 §10 U1。~~ **已修（2026-09-15）**：`seed=true` 改为写**正的做种分钟数**（`config.seedTimeMinutes`，缺省 1440），非法值一律回落默认；见 §9 与 §10 U1（已闭环）。

## 9 · 实践修订记录

- **2026-09-15 · 修「已证伪待裁决」的 `seed` 反义缺陷 + 让 daemon 死亡可见（`t-490458d8` 第 2 组）**
  - **① `seed=true` 从「空操作」修成真做种**：原实现写 `seed-time='0'`（aria2 语义 = 下载完**停止**做种），与参数文案「完成后继续做种」**相反**，且与 daemon 全局 `--seed-time=0` 逐字节相同 ⇒ **对行为零影响**。修法取 §10 U1 自己列的首选：**写正数** —— 新增 `Config.seedTimeMinutes`（缺省 `1440` = 24h），经 `download_add` → `aria2.add` → `buildAddOptions` 透传为单任务 `seed-time`（单任务值**覆盖** daemon 全局值才有效果）；非法输入（0/负/NaN/Infinity/非数）**一律回落默认**——0 是反义值，绝不能漏进去。`bt-seed-unverified` 保留（只在真做种时有意义）。
  - **② 判据守卫**：`tests/logic.test.mjs` 把「已证伪」那条哨兵翻成修复断言——`seed:true` 的 `seed-time` **必须不等于** daemon 全局值（原来的等值断言正是缺陷的机器指纹）；另加两条边界（非法值回落、`seed` 非严格 true 不产键）。
  - **③ daemon 死亡可见**：`ensure()` 现返回 `{started}`（`true` = 本次**新拉起**了 daemon），`download_list` 透出 `daemonStarted` 并在 `true` 时打印告警行「此前不可达、本次已（重新）拉起——若你并未主动停止过它，说明它中途退出过」。**这不是巡检**（刻意不引入第二个 owner，见 §5.19/U4），而是把「本来就活着」与「刚被我拉起」这两个此前无法区分的情形**变得可区分**——否则 daemon 中途死亡在下一次工具调用里也看不出痕迹（D10 形状：新判据若对既存情形恒空，等于假修复）。
  - **④ 同步**：§4.1 配置表 + §5 不越界清单 + §7（A13 改判、新增 A15）+ §8 + §10 U1/U4 + `tests/spawn-contract.test.mjs` 源码守卫。

- **2026-09-14 · 进程崩溃缺陷：spawn 失败无 `'error'` 监听器 → 打崩宿主 web（已修 + 加机器守卫）**
  - **症状**：`src/aria2.ts:spawn()` 用 `spawn('aria2c', args, …)` 拉起 daemon，**从未注册 `'error'` 监听器**。
    spawn 失败（`aria2c` 不在 PATH = ENOENT、EACCES）时 Node 在 ChildProcess 上 emit `'error'`；
    无监听器 ⇒ 该事件被抛成未捕获异常 ⇒ **宿主 web 进程崩溃**。而 `apply()` 在装载时就预热
    `aria2.ensure()` ⇒ **「没装 aria2c 的机器上挂载本插件 = web 起不来」**（守护会反复拉起 → 重启循环）。
  - **证伪证据（修前）**：`tests/spawn-contract.test.mjs` 的尸体测试用真实子进程复刻该形态——
    `spawn('dsh-definitely-not-a-real-binary-xyz', …)` 不注册监听器 → `status≠0` 且 stderr 含 `ENOENT`；
    对照组（注册 `'error'` 监听器）→ `status=0` 并打印 `CONSUMED`。
  - **修复**：`spawn()` 注册 `proc.on('error', …)` 写入 `spawnError`；`ensure()` 在轮询中**优先抛出该错误**，
    由调用方 `safe()` 收成 `{ok:false, error: 'aria2c 启动失败（ENOENT）…请确认 aria2c 已安装并在 PATH'}`。
  - **语义被补充（新不变量）**：**每个子进程调用点必须消费 `'error'` 事件**，且 daemon 必须满足
    生命周期契约（`detached:true` + `stdio:'ignore'` + `unref()`）——由静态守卫机器锁住（尸体样本已取得）。
  - **行为变更清单（唯一一处）**：环境缺失（`aria2c` 不存在）时，从「未捕获异常打崩 web」改为
    「`ensure()` 抛显式错误 → 工具返回 `{ok:false,error}`」；**aria2c 正常存在时行为完全不变**。

- **2026-09-14 · 逻辑可测试化（纯函数抽取，零行为变更）**
  - **语义被确认**：`buildDaemonArgs`/`buildAddOptions`/`buildLimitOptions`/`buildRpcBody`/`rpcErrorMessage`/
    `rpcBodyError`/`mapTask`/`mapGlobalStat`/`removeRpcMethod`/`fmtSize`/`fmtSpeed`/`shortGid` 从
    `aria2.ts`/`index.ts` 搬入 `src/logic.ts`，逐条对齐原实现；`rpc()` 由 `res.json()` 改为 `res.text()` + 纯函数解析
    （**语义等价**：合法 JSON 同结果，非 JSON body 同样回落 HTTP 状态文案，且不因读取 body 失败而新抛错）。
  - **语义被补充（此前无人知道的真实语义）**：`fmtSize(NaN)='0 B'`（`!NaN` 为真）、`fmtSize(-1)='-1.0 B'`（不取绝对值）、
    `mapTask` 的 `errorCode=0 → ''`（假值）、`mapTask.completed>total → progress>100`（不 clamp）、
    `mapTask({files:{}})` 会抛 `TypeError`（脏类型，靠工具层 `safe()` 收口）、`buildLimitOptions(NaN)='NaNK'`、
    `removeRpcMethod` 对未知状态按「活跃」处理（保守：真删任务而非仅清记录）。
  - **语义被修正（我自己的预期错）**：首版断言 daemon argv 数量 `> 30`，实测 **29** —— 改预期为 `>= 25`
    并把真实条数写进断言消息（**预期写错就改预期，不是改代码**）。
  - **判据修正（守卫误报）**：静态扫描器首版用 `\bspawn\s*\(` 抓调用点，把 `this.spawn()` 与
    `private spawn(): void` 也算成子进程调用 → 6 条误报。改为「首参必须是字符串字面量」后归零。
    **教训：判据失真比缺陷更贵（假阳性成本 = 假阴性 × 调用点数）**——先修判据，再谈被测对象。
  - **测试平台无关性（WSL 侧复跑暴露）**：`mapTask` 的名称回落用宿主平台 `path.basename` ——
    断言硬编码 `'f.bin'` 在 Windows 成立、在 POSIX 不成立（反斜杠不是分隔符）。**这是我预期写得平台相关，
    不是代码错**（生产跑在 Windows，行为正确）；已改为按宿主平台取期望并补 POSIX 路径用例。
    纪律：**单测必须在两个执行环境（Windows pwsh 与 WSL）都绿**，否则「全绿」只是半边证据。

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：daemon detached 常驻 + 跨 web 重启复用；RPC 只回环 + token 持久化；`ensure()` 是所有工具的前置；`removeFiles` 是唯一破坏面。
  - 语义**被补充**：`<DSH_HOME>/data/dsh-download-pro/token` 与 `session` 两个落盘点（此前只在源码里）；`apply` 末尾会**主动预热 daemon**（`config.enabled` 真的被消费，与 cyber-range 的 `enabled` 死配置形成对照）。
  - 语义**被修正**：无（首次成文）。
  - 教训：同一生态内「配置字段是否被消费」并不一致——语义文档必须逐字段写「谁读它」，否则读者会把 `enabled`/`defaultResolveIp` 这类字段的效力一概而论。

## 10 · 未决问题

- ~~**U1 `seed=true` 语义**：参数描述「完成后继续做种」，实现写入 `seed-time=0`（= 完成后**不**做种），且与 daemon 全局 `--seed-time=0` 逐字节相同 ⇒ 对行为**零影响**（没接线）。~~ → **已闭环（2026-09-15）**：取本条目首选方案（写正数）——新增 `Config.seedTimeMinutes`（缺省 1440），单任务 `seed-time` 覆盖 daemon 全局值；非法值回落默认；哨兵断言翻转为「必须不等于全局值」。见 §9、§7 A13。
- **U2 无 `download_shutdown`**：刻意不提供（防误杀 daemon）。是否需要一个「显式停止引擎」的带确认路径？倾向：保持不提供，需要时用 WSL/pwsh 手动。
- **U3 `removeFiles` 的静默 catch**：单文件删除失败被吞（`catch { /* 忽略单个删除失败 */ }`），违反「不许静默」。倾向：把失败路径收集为 `failedDeletes[]` 回传。
- **U4 daemon 无守护**：web 崩溃 → daemon 仍在，但若 daemon 自身崩溃，只有下一次工具调用才发现。倾向：**不引入巡检**（避免第二个 owner，见 §5.19）。
  → **部分闭环（2026-09-15）**：不加巡检（判断不变），但让「下一次工具调用」**看得出**发生过崩溃——`ensure()` 返回 `{started}`、`download_list` 透出 `daemonStarted` 并告警（见 §9-③、§7 A15）。仍缺：daemon 死亡期间**在飞的下载**无人接管（要真恢复需巡检/重启，属刻意不做）。
