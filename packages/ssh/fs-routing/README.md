# @deepseek-ai/dsh-fs-routing

English | [中文](README.zh.md)

Routing Service Provider that lets one harness instance serve local and `ssh://host/path` remote workspaces at once. The `fs-routing` function plugin (`name`/`inject`/`apply`) registers three services over the seams it owns: `RoutingFileSystem` (`ctx.fs`), `RoutingSubprocessRuntime` (`ctx.subprocess`), and `RoutingShellExecutor` (`ctx.shell`).

## Behavior

- **Routing by working directory** — a session's `cwd` decides the backend: `ssh://host[:port]/path` cwds go to the SSH adapters for that host, everything else to the embedded sandboxed local filesystem, local subprocess runtime, and bash sandbox executor, each in an isolated scope so the single-backend providers they replace can be disabled.
- **Stable routing keys** — every resolved `FsTarget` carries a `route:local:` or `route:ssh:<hostKey>\n<inner>` `targetKey`, so follow-up operations route back to the exact backend that minted it ([`./route`](src/route.ts) exports the vocabulary). Mashed absolute paths that lost the `ssh://` scheme (`…/ssh:/host:port/remote/path`) are recovered before routing.
- **Local-only without profiles** — the [`ctx.ssh`](../ssh/README.md) pool is always injected; with no profile configured, `ssh://` operations fail loud at the pool and everything local behaves exactly as the replaced providers.
- **Remote shell authority** — an `ssh://` workdir bypasses the local sandbox runner (it cannot confine remote processes) and runs `bash -c` on the host with the SSH account's full authority; local workdirs keep the wrapped executor's confinement intact.

## Config

```yaml
- id: fs-routing
  name: '@deepseek-ai/dsh-fs-routing'
  config:
    cwd: /path/to/local/workspace   # local backend default; default: process.cwd()
```

## Model Experience

Indirectly, through `dsh-tool-fs`, `dsh-tool-fs-search`, and `dsh-tool-bash`, which render routed operations exactly as single-backend ones.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **No stdin on remote commands** — remote shell runs reject a `stdin` spec; callers must embed input in the command until remote stdin channels land.
- **Stub containment answers** — `RoutingFileSystem.contains` returns `false` and `fileUrl` returns `''` for routed targets, so containment-based checks and file links degrade for remote paths.
- **Windows local shell** — the routed executor wraps only the bash sandbox executor; a Windows host loses its local pwsh executor under this routing layer.
- **No remote terminals** — PTY sessions over SSH throw at `spawnTerminal`; see [`dsh-subprocess-ssh`](../subprocess-ssh/README.md).
