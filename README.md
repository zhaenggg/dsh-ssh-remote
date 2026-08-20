# dsh-ssh-remote

SSH remote execution plugin set for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): give an agent session an `ssh://host[:port]/path` working directory, and every capability — filesystem, subprocess, shell, search — executes on the remote host over SSH, with the same budgets, output collection, and session-log trail as local sessions.

中文说明见 [README.zh.md](README.zh.md)。

## Packages

| Package | Role |
|---|---|
| `@zhaenggg/dsh-ssh` | Connection pool (service `ctx.ssh`). Profiles from `DSH_SSH_PROFILES` env (JSON) or the browser-side settings page. No profiles ⇒ local-only, nothing remote activates. |
| `@zhaenggg/dsh-fs-ssh` | SFTP filesystem backend for the `fs` seam. |
| `@zhaenggg/dsh-subprocess-ssh` | Remote exec backend for the `subprocess` seam. |
| `@zhaenggg/dsh-fs-routing` | The composition layer: one `ctx.fs` / `ctx.subprocess` / `ctx.shell` routed by session cwd — local cwds keep the sandboxed local backends, `ssh://` cwds run on the remote host. |
| `@zhaenggg/dsh-client-ui-settings-ssh` | Browser-side SSH server settings page. |

`plugins/ssh-selftest` is a dev-only driver that runs one agent turn against an `ssh://` cwd end-to-end.

## Requirements

The plugin packages are published under the `@zhaenggg` npm scope; they depend on official `@deepseek-ai/*` harness packages (`dsh-fs`, `dsh-subprocess`, `dsh-shell`, `dsh-sandbox*`, `cordis`, …), which come from the harness install.

The plugin set builds and tests inside a [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) pnpm workspace checkout: the packages depend on workspace siblings (`dsh-fs`, `dsh-subprocess`, `dsh-shell`, `dsh-sandbox*`, …). Full `ssh://` cwd support also needs the host-side integration (workspace/session/shell/sandbox seams accepting `ssh://` cwds); this repository carries the plugin packages, and the host integration ships with the harness.

## Compose

In your profile's `cordis.patch.yml` (or app composition), replace the single-backend rows with the pool plus the routing layer:

```yaml
- id: fs-sandbox
  disabled: true
- id: subprocess
  disabled: true
- id: bash-sandbox
  disabled: true
- id: pwsh-sandbox
  disabled: true

- insert:
    - id: ssh
      name: '@zhaenggg/dsh-ssh'
    - id: fs-routing
      name: '@zhaenggg/dsh-fs-routing'
```

With no SSH profile configured the composition behaves exactly like the local providers it replaces.

## Configure servers

`DSH_SSH_PROFILES` is a JSON array of profiles:

```json
[
  {
    "host": "192.168.21.250",
    "port": 8322,
    "username": "zz",
    "password": "…",
    "cwd": "/home/zz"
  }
]
```

`privateKeyPath` / `privateKey` are also accepted. A session cwd of `ssh://192.168.21.250:8322/home/zz` routes to that host; unknown hosts fail loud (`no profile for <host>`), never a silent local fallback. The browser settings page writes the same profile store.

## Develop

```sh
git clone https://github.com/zhaenggg/dsh-ssh-remote vendor/dsh-ssh-remote   # inside a harness checkout, or symlink the packages
pnpm install
pnpm vitest run packages/ssh
```

Tests include a REAL-composition suite that boots a test `cordis.yml` through the cordis Loader with the routing layer mounted.

## Known limitations

- Remote shell commands have no stdin and no PTY (`spawnTerminal` rejects with an explicit error).
- `contains()` / `fileUrl()` are structural stubs at the routing layer.
- No host-key verification: profiles trust the network path.
- On a Windows host, the routed local shell wraps only the bash sandbox (remote sessions are unaffected).
- Remote writes do not create parent directories (SFTP semantics).

## License

MIT
