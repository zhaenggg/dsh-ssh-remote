# @zhaenggg/dsh-subprocess-ssh

[English](README.md) | 中文

[`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) 能力在远程 SSH 主机上的 Service Provider：`SshSubprocessRuntime`（默认导出，`ctx.subprocess`）把每个 spawn spec 作为共享 [`ctx.ssh`](../ssh/README.md) 连接上的一条 `ssh2` exec 通道执行。[`@zhaenggg/dsh-fs-routing`](../fs-routing/README.md) 为每个 host key 构造一个实例；spec 的 `cwd` 选定主机。

## Behavior

- **远程命令形态** —— 一个 spawn 变为 `cd '<cwd>' && [env k=v …] '<argv0>' '<argv1>' …`，POSIX 单引号转义；任何部分都不经本地 shell 解释。
- **有界收集** —— collect 模式的 stdout/stderr 在 spec 的 `maxBytes` 内保留内存尾部，退出后仍可按偏移读取。
- **spawn 失败响亮** —— `getClient` 被拒（未知 profile、连接失败）或 exec 出错时，handle 的 `done` 携带底层消息 reject，符合 seam 的 spawn 级失败契约。
- **可执行文件解析** —— `resolveExecutable` 用 `command -v` 探测远程登录 shell，含路径分隔符的名字直接 reject。
- **销毁汇合存活工作** —— fiber 销毁等待存活 handle 并终止存活终端，之后连接池才关闭客户端。

## Model Experience

Indirectly, through `dsh-fs-routing` and `dsh-tool-bash`, which render remote command results exactly as local ones.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **无 stdin** —— 远程 spawn 一律关闭 stdin；需要输入的调用方必须把输入嵌入命令。
- **无 PTY** —— `spawnTerminal` 直接抛错（`subprocess-ssh: spawnTerminal is not yet implemented`）；SSH 上的终端会话仍属延后。
- **无远程 pid** —— handle 报告 `pid: -1`；不采集远程进程号，终止通过关闭 exec 通道而非按 pid 发信号。
- **`pollMs` 保留** —— 该 config 字段经过校验但未使用；尚不存在轮询面。
