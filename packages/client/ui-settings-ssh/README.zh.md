# @zhaenggg/dsh-client-ui-settings-ssh

[English](README.md) | 中文

SSH 远程 设置页的浏览器半侧：注册标签为 SSH 远程 的 `settings.section` 条目并渲染 `SshSettingsSection`——一个可编辑的远程服务器 profile 列表（名称、主机、端口、用户名、密码）。保存时经 settings API 把完整列表写入 `ssh` 设置分区；[`dsh-ssh`](../../ssh/ssh/README.md) 连接池无需重启即从该分区重建 profile 映射，新远程工作区立即可用。每个 profile 成为侧栏中的一个工作区条目。

## Behavior

- **分区即事实来源** —— 页面读取持久的 `ssh` 分区、编辑本地草稿、保存时整体替换；不存在部分更新。
- **环境变量 profile 在下层** —— `DSH_SSH_PROFILES` 的行保持生效；同 `host:port` 的设置行覆盖之。
- **仅密码认证** —— 行形状只携带 `password`；基于密钥的 profile 属于 config 行或环境变量（[`dsh-ssh` 限制](../../ssh/ssh/README.md#known-limitations-and-deferred-work)）。

## Model Experience

Indirectly, through `dsh-ssh`, whose connection pool the saved profiles configure for the remote filesystem and subprocess adapters.

#### KV Cache effect

No direct invalidation; `dsh-ssh` and its adapters own any request-prefix changes.

## Known Limitations and Deferred Work

- **无连通性测试** —— 保存不校验 profile；错误的主机或凭据在第一次工作区操作时暴露。
- **编辑时不遮蔽机密** —— 已保存密码在设置页以普通文本输入框呈现。
