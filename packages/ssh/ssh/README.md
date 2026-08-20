# @zhaeng/dsh-ssh

English | [中文](README.zh.md)

Shared SSH connection lifecycle for DeepSeek Harness remote-server adapters: `SshRuntime` (default export, `ctx.ssh`) owns one `ssh2` `Client` per `host[:port]`, connecting lazily, keeping connections alive with 30-second keepalives, and ending every client on fiber disposal. The [`./paths`](src/paths.ts) entry owns the `ssh://host[:port]/remote/path` vocabulary — `isSshPath`, `parseSshPath`, `buildSshPath`, `hostKeyFromPath` — used by the workspace, search, and routing layers to recognize remote working directories.

## Profiles

A profile names one remote host and its credentials. Three layers build the effective map, in this order:

1. **The plugin config row** — one profile from its `Config` fields.
2. **`DSH_SSH_PROFILES`** — a JSON array of the same `Config` shape, read once at startup; a malformed value keeps the profiles already ingested and logs the rejection.
3. **The `ssh` settings section** — the [GUI SSH settings page](../../client/ui-settings-ssh/README.md) writes password-auth profile rows; every committed change rebuilds the map without a restart, and a settings row overrides an env row with the same `host:port`.

An entry without a `host` contributes no profile; the shipped web composition inserts the plugin with empty host fields and receives hosts exclusively through the upper layers.

## Behavior

- **Loud failure on unknown hosts** — `getClient(hostKey)` rejects with the known-profile list when no profile matches, so a misrouted `ssh://` workspace fails at the first operation instead of silently running locally.
- **Validation at connect** — a profile must carry a `username` and at least one of `privateKey`, `privateKeyPath`, or `password`, and a positive finite `connectTimeoutMs`; violations reject the connect promise.
- **Agent auth when present** — `SSH_AUTH_SOCK` routes authentication through the local SSH agent; explicit key material and passwords take their normal `ssh2` precedence.
- **Remote roots** — `getCwd(hostKey)` returns the profile's remote workspace root (default `/home/user/workspace`); `getRuntimeRoot(hostKey)` appends `.dsh-ssh` for adapter state.

## Config

```yaml
- id: ssh
  name: '@zhaeng/dsh-ssh'
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

- **No host-key verification** — connections accept any server host key; deploy `dsh-ssh` only against trusted networks until `known_hosts` pinning lands.
- **Password-only settings rows** — the `ssh` settings section (the GUI page) carries `password` only; key-based auth needs the config row or `DSH_SSH_PROFILES`.
- **No active health checking** — a half-open connection surfaces as a failed operation; recovery is a fresh `getClient` round after the `close` handler drops the settled client.
