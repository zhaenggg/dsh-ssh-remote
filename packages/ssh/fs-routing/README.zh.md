# @zhaenggg/dsh-fs-routing

[English](README.md) | 中文

让一个 harness 实例同时服务本地与 `ssh://host/path` 远程工作区的路由 Service Provider。`fs-routing` 函数插件（`name`/`inject`/`apply`）在其接管的 seam 上注册三个服务：`RoutingFileSystem`（`ctx.fs`）、`RoutingSubprocessRuntime`（`ctx.subprocess`）与 `RoutingShellExecutor`（`ctx.shell`）。

## Behavior

- **按工作目录路由** —— 会话的 `cwd` 决定后端：`ssh://host[:port]/path` cwd 走该主机的 SSH 适配器，其余走内嵌的沙箱本地文件系统、本地子进程运行时与 bash 沙箱执行器，各在隔离 scope 中，被替代的单后端 provider 可以禁用。
- **稳定路由键** —— 每个解析出的 `FsTarget` 携带 `route:local:` 或 `route:ssh:<hostKey>\n<inner>` 的 `targetKey`，后续操作据此路由回铸造它的后端（[`./route`](src/route.ts) 导出该词表）。丢失 `ssh://` scheme 的拼接绝对路径（`…/ssh:/host:port/remote/path`）在路由前被恢复。
- **无 profile 即 local-only** —— [`ctx.ssh`](../ssh/README.md) 连接池始终注入；未配置 profile 时 `ssh://` 操作在池上响亮失败，本地行为与被替代的 provider 完全一致。
- **远程 shell 权限** —— `ssh://` workdir 旁路本地沙箱 runner（它无法约束远程进程），在主机上以 SSH 账号的完整权限运行 `bash -c`；本地 workdir 保持被包裹执行器的约束不变。

## Config

```yaml
- id: fs-routing
  name: '@zhaenggg/dsh-fs-routing'
  config:
    cwd: /path/to/local/workspace   # local backend default; default: process.cwd()
```

## Model Experience

Indirectly, through `dsh-tool-fs`, `dsh-tool-fs-search`, and `dsh-tool-bash`, which render routed operations exactly as single-backend ones.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **远程命令无 stdin** —— 远程 shell 拒绝携带 `stdin` 的 spec；远程 stdin 通道落地前调用方需把输入嵌入命令。
- **包含关系回答为桩** —— `RoutingFileSystem.contains` 对路由目标返回 `false`，`fileUrl` 返回 `''`，基于包含关系的检查与文件链接在远程路径上退化。
- **Windows 本地 shell** —— 路由执行器只包裹 bash 沙箱执行器；Windows 宿主在该路由层下失去本地 pwsh 执行器。
- **无远程终端** —— SSH 上的 PTY 会话在 `spawnTerminal` 抛错；见 [`dsh-subprocess-ssh`](../subprocess-ssh/README.md)。
