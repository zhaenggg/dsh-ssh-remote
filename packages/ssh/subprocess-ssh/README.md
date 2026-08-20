# @zhaenggg/dsh-subprocess-ssh

English | [中文](README.zh.md)

Service Provider for the [`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) capability on a remote SSH host: `SshSubprocessRuntime` (default export, `ctx.subprocess`) executes each spawn spec as one `ssh2` exec channel on the shared [`ctx.ssh`](../ssh/README.md) connection. [`@zhaenggg/dsh-fs-routing`](../fs-routing/README.md) constructs one instance per host key; the spec's `cwd` selects the host.

## Behavior

- **Remote command shape** — a spawn becomes `cd '<cwd>' && [env k=v …] '<argv0>' '<argv1>' …` with POSIX single-quote escaping; no local shell interprets any part of it.
- **Bounded collection** — collect-mode stdout/stderr keep an in-memory tail under the spec's `maxBytes` and stay readable after exit through offset-based readers.
- **Loud spawn failures** — a rejected `getClient` (unknown profile, connection failure) or an exec error rejects the handle's `done` with the underlying message, per the seam's spawn-level-failure contract.
- **Executable resolution** — `resolveExecutable` probes the remote login shell with `command -v` and rejects for names containing path separators.
- **Disposal joins live work** — fiber disposal waits for live handles and terminates live terminals before the pool closes its clients.

## Model Experience

Indirectly, through `dsh-fs-routing` and `dsh-tool-bash`, which render remote command results exactly as local ones.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **No stdin** — every remote spawn runs with stdin closed; callers needing input must embed it in the command.
- **No PTY** — `spawnTerminal` throws (`subprocess-ssh: spawnTerminal is not yet implemented`); terminal sessions over SSH remain deferred.
- **No remote pid** — handles report `pid: -1`; the remote process id is not captured, so termination closes the exec channel rather than signalling a pid.
- **`pollMs` reserved** — the config field is validated but unused; no polling surface exists yet.
