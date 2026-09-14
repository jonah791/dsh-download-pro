<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 资源下载插件：aria2 JSON-RPC 引擎操控面——磁力/BT/HTTP 直链下载管理（添加/列表/详情/暂停恢复移除/全局限速），daemon 常驻不随 web 重启中断
  inject: 'tools'
  tools: download_add, download_list, download_status, download_control, download_global（5 个）
  runtime: host-only
  envDeps: aria2c 可执行文件（PATH 内）+ 下载目录可写；RPC 只监听 127.0.0.1
  boundary: 能 rmSync 删除已下载文件与其空父目录（removeFiles 默认 false）；不搜索资源、不上传、不暴露 RPC 到局域网
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-download-pro

<p align="center">
  <a href="https://github.com/jonah791/dsh-download-pro"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-44%20passed-brightgreen" alt="tests">
</p>

**一句话**：给 agent 一个 **aria2 RPC 操控面**——磁力链 / BT 种子 / HTTP 直链的添加、查询、暂停、移除、全局限速，五个工具搞定。

**为什么值得用**：下载是**长时任务**，最怕「服务一重启，下了 8 小时的种子没了」。本插件把 aria2 拉成 **detached daemon**：web 重启**不中断下载**（插件重连时 ping 一下直接复用），任务状态由 aria2 自己的 session 文件跨重启恢复。另外把 aria2 的**语义坑**替你处理掉了——对已完成任务 `pause` 会返回 HTTP 400、对 stopped 任务 `remove` 报 "Active Download not found"，插件按状态分流（幂等短路 / 走 `removeDownloadResult`），你拿到的永远是 `{ok, ...}` 而不是异常。

## 能力

| 工具 | 用途 |
|------|------|
| `download_add` | 添加任务：`magnet:` 磁力链 / `http(s)://` 直链 / `.torrent` 链接；可覆盖目录、重命名、`seed` 选项 |
| `download_list` | 任务列表（下载中 / 等待 / 已结束），含进度 / 速度 / 大小 |
| `download_status` | 单任务详情：进度、速度、连接数、BT 做种数、文件列表、错误 |
| `download_control` | `pause` / `resume` / `remove` / `force-remove`；`remove` 可带 `removeFiles` 一并删文件 |
| `download_global` | 全局统计 + 全局限速（`downloadLimit` / `uploadLimit`，KB/s；传 `0` = 不限速） |

> 刻意**不提供** `download_shutdown`——防止一次误调用中断全部下载。要停引擎需显式 `aria2.shutdown` RPC 或 `taskkill /IM aria2c.exe`。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-download-pro": "link:<工作区>/self-plugins/dsh-download-pro"
```

**2) 装引擎**：`aria2c` 需在 PATH 内（scoop / choco / 官方 zip 均可）。插件会在挂载时与每次调用前自动 `ensure()` 拉起 daemon（20s 超时，超时报 `aria2 守护进程启动超时（20s）`）。

**3) 挂组合**（web profile patch 行；默认配置即可用）：

```yaml
- insert:
    - id: agent-download-pro
      name: dsh-download-pro
```

**4) 30 秒验证**：调 `download_global` → 应返回真实统计（`numActive` / `numWaiting` / `numStoppedTotal`）；同时 `netstat -ano | findstr :16880` 应只出现 `127.0.0.1:16880`（只回环，不是 `0.0.0.0`）。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | **被消费**：`apply` 末尾 `if (config.enabled) aria2.ensure()`（启动即预热 daemon） |
| `rpcPort` | `16880` | RPC 端口。**不可用 6800**——Windows 排除端口段 6644–7043 内，绑定会报 "Failed to bind a socket" |
| `dir` | 本机下载目录 | 默认下载目录（`--dir`） |
| `maxConcurrent` | `5` | 最大并发下载数（`--max-concurrent-downloads`） |
| `rpcSecret` | `''` | 空 = 自动生成随机 token 并持久化到 `<dataDir>/token` |

## 落盘与自证（出问题时先看这里）

**侧车轨迹：无**（未接入 `*-trace.jsonl`）。本插件写出三类持久产物：

| 产物 | 落点 | 写入方式 / 读取语义 |
|------|------|-------------------|
| RPC token | `<DSH_HOME>/data/dsh-download-pro/token` | 启动时读，非空即用；读失败/缺失则重新生成并覆盖写（**不删旧文件**）；写失败不致命（仅本次会话有效） |
| aria2 会话 | `<DSH_HOME>/data/dsh-download-pro/session` | 由 **aria2c 自身**每 60s 刷新；用于跨重启恢复任务——**mtime 前进 = daemon 活着** |
| 下载产物 | `config.dir`（默认本机下载目录） | aria2c 自身写；`download_control remove + removeFiles=true` 时插件 `rmSync` 删除，父目录**仅当为空**才删 |

**一条命令答五问**（该文件是 aria2 会话快照，**无阶段枚举**）：

```bash
tail -1 "$DSH_HOME/data/dsh-download-pro/session"
# ① 跑的是哪个构建   → 答不了（无 build 自报）。改用 lib/*.js mtime vs web 进程启动时间，见下节
# ② 谁发起           → 答不了（无 caller 字段）。改用调用会话与 download_list 的 gid
# ③ 断在哪一段       → 答不了阶段枚举。改用 download_status 的 status / errorCode / errorMessage
# ④ 结果质量         → 会话行数 ≈ 未完成任务数；真正的质量面看 download_list 的进度/速度/numStopped
# ⑤ 耗时与预算       → 答不了（无时间戳）。改用 session 文件 mtime 是否在 60s 内前进（daemon 存活判据）
```

**行为级验证**：`download_global` 返回真实统计（非 `{ok:false}`）＋ `netstat -ano | findstr :16880` 只见 `127.0.0.1` ＋ `<dataDir>/session` mtime 持续前进。

## 生效判据与回退

**生效判据**（按可靠性排序）：
1. **进程级**：`self-plugins/dsh-download-pro/lib/index.js` 与 `lib/aria2.js` 的 mtime **早于** web 进程启动时间 ⇒ 进程在跑当前构建；
2. **落盘产物**：`<DSH_HOME>/data/dsh-download-pro/token` 存在且非空；
3. **行为级**：五个 `download_*` 工具在工具面里，且 `download_global` 返回真实统计。

**反证（很重要）**：`download_global` 通但 `aria2.getVersion` 返回的版本与 `aria2c --version` 不一致 ⇒ 你连上的是**另一个** aria2 实例（端口冲突），不是本插件拉起的。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，**进程启动时间晚于产物 mtime** 才算「在跑它」。改完源码必须 `pnpm build`/`npm run build` 并让预检看到新产物。

**回退**：
- 源码级：`git -C self-plugins/dsh-download-pro revert <commit>` → 构建 → `preflight_check` → 哨兵重启；
- 组合级：patch 里给 `agent-download-pro` 行加 `disabled: true`（或移除该行）→ 哨兵重启；
- 运行期（**数据面回退**）：daemon 不停，可继续下载——web 重启只会重新 `ensure()`，daemon 已在则直接复用（**不重启下载**）。要彻底停引擎需显式 `aria2.shutdown` RPC 或 `taskkill /IM aria2c.exe`。

## 测试

```bash
npm run build && npm test        # build = tsc；test = node --test "tests/*.test.mjs"
```

**44 例离线测试全绿**（2026-09-14 实测 `# pass 44 / # fail 0`）：

- `tests/logic.test.mjs`（30 例）— 纯逻辑层：格式化（`0`/`NaN`/负数/`Infinity` 退化）、argv 拼装（`--rpc-listen-all=false` 必在、secret 透传、DHT/BT 端口不在 Windows 排除段 6644–7043、`--save-session` 路径不含反斜杠、**每个 argv 元素独立不拼 shell 串**）、RPC 载荷、任务映射（脏类型 `files:{}`、缺字段、`errorCode=0`、未知 action、非 JSON body）
- `tests/spawn-contract.test.mjs`（14 例）— **尸体测试**：用真实子进程证明「spawn 失败 + 无 `'error'` 监听器 = 非零退出 + ENOENT」，对照证明「注册监听器 = 不崩」；静态守卫要求**每个 `spawn('…'` 调用点都消费 `'error'`**
- 另有静态断言：`src/logic.ts` 不含 `child_process`、不含 `fetch(`（保持纯逻辑可离线测）

**离线单测不需要 aria2c、不需要网络、不需要真实下载**——`spawn-contract` 用的是必然失败/无害的子进程样本。真实 daemon 的行为（A1–A9：只回环、凭据持久化、重启不中断、pause 已完成任务、removeFiles 删空目录…）仍需**线上验收**，离线单测不替代。

## 设计要点

- **I1 RPC 只回环**：daemon 以 `--rpc-listen-all=false` 启动，客户端恒连 `127.0.0.1`——局域网不可达（`netstat` 可验）。随机 token 认证，凭据持久化在 `<DSH_HOME>/data/dsh-download-pro/token`。
- **I2 每次调用前 `ensure()`**：`grep -c "aria2.ensure()" src/index.ts` = 6（5 个工具各 1 + `apply` 内 1）——daemon 被外部杀掉也能自愈，不靠人工重启 web。
- **I3 disconnect 不杀 daemon**：`apply` 的清理**不**调 `shutdown()`——否则重启即中断所有下载任务。这是本插件的核心生命周期约束。
- **I4 无裸抛**：所有工具体经 `safe()` 包装；`ping()` 吞错返回 bool；`shutdown()` 吞错。
- **I5 端口不落陷阱区**：RPC 默认 `16880`、BT/DHT 监听 `46000-47000`，均避开 Windows 保留段 6644–7043。
- **aria2 语义分流**：`pause` 已完成/已移除任务 → 不调 RPC、返回 `ok:true` + `note`；`resume` 已 active / `pause` 已 paused → 幂等短路；`remove` 对 stopped 任务走 `removeDownloadResult`。
- **删除面收敛**：`removeFiles` **默认 `false`**，只在显式传参时生效；删目录**仅当为空**（防误删）。

### 安全边界（重要）

能力边界 ≠ 沙箱：本插件能写 `dir`、能递归删除已下载文件与其**空**父目录——删除面是真实风险点，因此默认关闭。不越界清单：不搜索资源、不解析种子内容、不做种（`--seed-time=0`）、不暴露 RPC 到局域网、不写 `dir` 与 `dataDir` 之外的路径。

> 已知缺口（如实标注）：`removeFiles` 单文件删除失败时 `catch {}` **静默忽略**（其余文件继续删）——与「不许静默」纪律相抵，已登记在语义文档 §10 U3。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语表、概念模型与不变量（I1–I5）、契约（配置 / **落盘契约** / 状态裁决表 / 调用点清单）、边界与信任、可证伪验收清单（A1–A14）、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `search-resource-freshness` | 新资源搜索实战（磁力/资源源探测矩阵）——与本插件构成「发现 ↔ 下载」前后工序 |
| 姊妹插件 `dsh-search-pro` | 多引擎搜索（含网盘/磁力检索），搜索到资源后交给本插件下载 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
