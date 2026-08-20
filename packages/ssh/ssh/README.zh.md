# @deepseek-ai/dsh-ssh

[English](README.md) | 中文

DeepSeek Harness 远程服务器适配器共享的 SSH 连接生命周期：`SshRuntime`（默认导出，`ctx.ssh`）为每个 `host[:port]` 持有一条 `ssh2` `Client`，惰性建连，以 30 秒 keepalive 保活，并在 fiber 销毁时结束全部客户端。[`./paths`](src/paths.ts) 入口持有 `ssh://host[:port]/remote/path` 词表——`isSshPath`、`parseSshPath`、`buildSshPath`、`hostKeyFromPath`——工作区、搜索与路由层用它识别远程工作目录。

## Profiles

一个 profile 命名一台远程主机及其凭据。生效映射按以下顺序由三层构成：

1. **插件 config 行** —— 由其 `Config` 字段构成一个 profile。
2. **`DSH_SSH_PROFILES`** —— 同一 `Config` 形状的 JSON 数组，启动时读取一次；格式非法时保留已摄取的 profile 并记录拒绝原因。
3. **`ssh` 设置分区** —— [GUI SSH 设置页](../../client/ui-settings-ssh/README.md) 写入仅密码认证的 profile 行；每次提交都无需重启即重建映射，且同 `host:port` 的设置行覆盖环境变量行。

没有 `host` 的条目不构成 profile；出厂 web 组合以空 host 字段插入本插件，主机完全经由上层到达。

## Behavior

- **未知主机响亮失败** —— `getClient(hostKey)` 在没有匹配 profile 时携带已知 profile 列表 reject，被误路由的 `ssh://` 工作区在第一次操作即失败，而不是静默落到本地。
- **连接时校验** —— profile 必须携带 `username` 与 `privateKey`、`privateKeyPath`、`password` 至少其一，以及正有限 `connectTimeoutMs`；违规使连接 promise reject。
- **存在即用 SSH agent** —— `SSH_AUTH_SOCK` 存在时经本地 SSH agent 认证；显式密钥与密码仍按 `ssh2` 的正常优先级。
- **远程根** —— `getCwd(hostKey)` 返回 profile 的远程工作区根（默认 `/home/user/workspace`）；`getRuntimeRoot(hostKey)` 追加 `.dsh-ssh` 作为适配器状态目录。

## Config

```yaml
- id: ssh
  name: '@deepseek-ai/dsh-ssh'
  config:
    host: 192.168.1.10      # empty in multi-host compositions
    port: 22
    username: deploy
    privateKeyPath: ~/.ssh/id_ed25519
    password: ''            # alternative to key auth
    cwd: /home/user/workspace
    connectTimeoutMs: 30000
```

## Model Experience

None, as this pool registers no model context; the remote filesystem and subprocess adapters and their tools own every rendered effect.

#### KV Cache effect

No direct invalidation; the adapters that consume `ctx.ssh` own any request-prefix changes.

## Known Limitations and Deferred Work

- **无主机密钥校验** —— 连接接受任意服务器主机密钥；在 `known_hosts` 固定落地前，仅在可信网络部署 `dsh-ssh`。
- **设置行仅密码** —— `ssh` 设置分区（GUI 页面）只携带 `password`；基于密钥的认证需走 config 行或 `DSH_SSH_PROFILES`。
- **无主动健康检查** —— 半开连接表现为操作失败；`close` 处理器丢弃已稳定客户端后，恢复路径是重新 `getClient`。
