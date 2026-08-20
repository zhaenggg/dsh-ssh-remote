# dsh-ssh-remote

SSH remote execution plugin set for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): give an agent session an `ssh://host[:port]/path` working directory, and every capability — filesystem, subprocess, shell, search — executes on the remote host over SSH, with the same budgets, output collection, and session-log trail as local sessions.

中文说明见 [README.zh.md](README.zh.md)。

## Packages

| Package | Role |
|---|---|
| `@zhaeng/dsh-ssh` | Connection pool (service `ctx.ssh`). Profiles from `DSH_SSH_PROFILES` env (JSON) or the browser-side settings page. No profiles ⇒ local-only, nothing remote activates. |
| `@zhaeng/dsh-fs-ssh` | SFTP filesystem backend for the `fs` seam. |
| `@zhaeng/dsh-subprocess-ssh` | Remote exec backend for the `subprocess` seam. |
| `@zhaeng/dsh-fs-routing` | The composition layer: one `ctx.fs` / `ctx.subprocess` / `ctx.shell` routed by session cwd — local cwds keep the sandboxed local backends, `ssh://` cwds run on the remote host. |
| `@zhaeng/dsh-client-ui-settings-ssh` | Browser-side SSH server settings page. |

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
      name: '@zhaeng/dsh-ssh'
    - id: fs-routing
      name: '@zhaeng/dsh-fs-routing'
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

Self-contained workspace — build with one command (dependencies come from npm):

```sh
pnpm install --ignore-scripts
pnpm -r --filter './packages/*/*' run build   # tsc typecheck + tsdown bundles per package
```

The package tests (including the REAL-composition suite) run inside a [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) checkout, where the full workspace graph and `dsh-test-sandbox` resolve.

## Known limitations

- Remote shell commands have no stdin and no PTY (`spawnTerminal` rejects with an explicit error).
- `contains()` / `fileUrl()` are structural stubs at the routing layer.
- No host-key verification: profiles trust the network path.
- On a Windows host, the routed local shell wraps only the bash sandbox (remote sessions are unaffected).
- Remote writes do not create parent directories (SFTP semantics).

## Publish

Packages are published under the [`@zhaeng`](https://www.npmjs.com/~zhaeng) scope (npm). Dependencies on official `@deepseek-ai/*` packages use published ranges (`dsh-* ^0.1.0-rc.x`, `cordis ^4.0.1`); inter-package references are pinned to matching versions.

Publishing is automated by one script (install → build → publish in dependency order). Accounts with two-factor authentication need an Automation-classic token in `~/.npmrc`; granular tokens and web-login tokens are rejected by the registry for publish.

```sh
./scripts/publish.sh
```

## License

MIT
