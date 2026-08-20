# @zhaenggg/dsh-fs-ssh

[English](README.md) | 中文

[`@deepseek-ai/dsh-fs`](../../fs/fs/README.md) 能力在 SFTP 之上的 Service Provider：`SshFileSystem`（默认导出）经由共享的 [`ctx.ssh`](../ssh/README.md) 连接池在单台远程主机上实现 `FileSystem` 操作。[`@zhaenggg/dsh-fs-routing`](../fs-routing/README.md) 为每个 host key 构造一个实例并把 `ssh://` 工作区路由过去；该类也可通过 `static inject = ['ssh']` 独立挂载。

## Behavior

- **解析** —— `resolve(path, { cwd })` 依次从 `ssh://` cwd、`ssh://` 路径、构造期 host hint 取主机，以 profile 远程 cwd 为基准解析远程路径并在主机上规范化；规范后的远程路径即不透明的 `targetKey`。
- **每操作一条 SFTP 通道** —— 每次 stat/read/write/list 都在池化客户端上开启 SFTP 会话并在操作结束后关闭，调用之间不残留通道状态。
- **并发写安全** —— 写与编辑按目标路径经内部锁链串行；`writeText` 遵守 `FsWriteIntent` 期望，`editText` 以与本地后端相同的输出词表做字面字符串替换。
- **错误映射** —— SFTP 失败映射为 `FsError` 码（缺失路径为 `FS_NOT_FOUND`，其余 `FS_IO_ERROR`），消息携带 display path，工具层的渲染与本地失败一致。

## Model Experience

Indirectly, through `dsh-tool-fs` and `dsh-tool-fs-search`, which render remote reads, writes, edits, and listings exactly as local ones.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **不受限** —— 远程 SSH 账号的权限是唯一边界；本地沙箱栈无法约束 SFTP 操作，对其直接旁路。
- **无分块流** —— `streamText` 整文件读取并作为单个 chunk 产出；增量 SFTP 流待有消费者需要时再实现。
- **无符号链接保留复制与目录移动** —— 写入走原子整文件替换；`listDir` 之外的递归操作属于调用方。
