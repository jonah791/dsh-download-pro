<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 资源下载插件：aria2 RPC 引擎，磁力/BT/HTTP 直链下载管理（添加/查询/暂停/移除/限速）
  inject: 'tools'
  tools: download_*
  runtime: host-only
  envDeps: aria2 引擎（RPC）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-download-pro


<p align="center">
  <a href="https://github.com/jonah791/dsh-download-pro"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
资源下载插件：**aria2 RPC 引擎**，磁力/BT/HTTP 直链下载管理。
与 dsh-search-pro 配套——搜索找到资源（磁力/直链）→ 本插件真正下载到本地。

## 能力

| 工具 | 功能 |
|------|------|
| `download_add` | 添加任务：magnet 磁力链 / http(s) 直链 / .torrent 种子链接；可覆盖目录、重命名、选择是否做种 |
| `download_list` | 任务列表（下载中/等待/已结束），含进度/速度/大小 |
| `download_status` | 单任务详情：进度/速度/连接数/BT 做种数/文件列表/错误 |
| `download_control` | pause / resume / remove / force-remove；remove 可带 `removeFiles` 删文件 |
| `download_global` | 全局统计 + 全局限速设置（KB/s） |

## 架构

- **引擎**：aria2c（需已安装，scoop/choco 均可），以 **RPC 守护模式**后台运行
  - daemon 是 detached 独立进程——**web 重启不中断下载**，插件重连复用
  - RPC 只监听 `127.0.0.1`，随机 token 认证（持久化于 `~/.dsh/data/dsh-download-pro/token`）
- **下载行为**：默认下载完即停（`--seed-time=0` 不做种）；断点续传；16 线程分段；`file-allocation=none` 快速分配
- **BT 网络**：DHT + PEX 解析磁力（无需 tracker）；BT 监听端口避开 Windows 排除端口范围

## 配置（Config）

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | true | 插件开关 |
| `rpcPort` | 16880 | aria2 RPC 端口（**不可用 6800**——Windows 排除端口范围 6644-7043 内） |
| `dir` | `D:\桌面\下载` | 默认下载目录 |
| `maxConcurrent` | 5 | 最大并发下载数 |
| `rpcSecret` | 自动生成 | RPC token（留空自动生成并持久化） |

## 已知边界（实测）

- **Windows 排除端口范围**：Hyper-V/WinNAT 保留 6644-7043（含 6800、6881-6999 默认 BT/DHT 端口），绑定会报 "Failed to bind a socket"——必须避开（RPC=16880、BT/DHT=46000-47000）
- **aria2 语义**：对已完成任务 `pause` 返回 HTTP 400（"cannot be paused now"）；对 stopped 任务 `remove` 报 "Active Download not found"——插件已对状态分流处理（pause/resume 前检查、stopped 任务走 `removeDownloadResult`）
- **磁力解析延迟**：磁力链需 DHT 解析（10-60s），期间任务为 `active`（metadata 下载中）；无种资源会长期 waiting

## 使用示例

```
download_add url="magnet:?xt=urn:btih:..."          # 添加磁力
download_list                                        # 查看进度
download_status gid="xxxxxxxx"                       # 单任务详情
download_control gid="xxxxxxxx" action="pause"       # 暂停
download_global downloadLimit=1024                   # 全局限速 1MB/s
download_control gid="xxxxxxxx" action="remove" removeFiles=true  # 移除并删文件
```
