# @zhaenggg/dsh-client-ui-settings-ssh

English | [中文](README.zh.md)

Browser half of the SSH 远程 settings page: registers the `settings.section` entry labeled SSH 远程 and renders `SshSettingsSection`, an editable list of remote-server profiles (name, host, port, username, password). Saving writes the complete list to the `ssh` settings namespace through the settings API; the [`dsh-ssh`](../../ssh/ssh/README.md) pool rebuilds its profile map from that section without a restart, so new remote workspaces are usable immediately. Each profile becomes a workspace entry in the sidebar.

## Behavior

- **The section is the source of truth** — the page reads the persisted `ssh` section, edits a local draft, and replaces the whole section on save; partial updates do not exist.
- **Env profiles stay underneath** — rows from `DSH_SSH_PROFILES` remain active; a settings row with the same `host:port` overrides one.
- **Password auth only** — the row shape carries `password`; key-based profiles belong to the config row or environment ([`dsh-ssh` limitations](../../ssh/ssh/README.md#known-limitations-and-deferred-work)).

## Model Experience

Indirectly, through `dsh-ssh`, whose connection pool the saved profiles configure for the remote filesystem and subprocess adapters.

#### KV Cache effect

No direct invalidation; `dsh-ssh` and its adapters own any request-prefix changes.

## Known Limitations and Deferred Work

- **No connectivity test** — saving does not verify the profile; a bad host or credential surfaces at the first workspace operation.
- **No secret masking on edit** — saved passwords render as ordinary text inputs in the settings page.
