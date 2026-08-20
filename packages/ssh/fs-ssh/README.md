# @deepseek-ai/dsh-fs-ssh

English | [中文](README.zh.md)

Service Provider for the [`@deepseek-ai/dsh-fs`](../../fs/fs/README.md) capability over SFTP: `SshFileSystem` (default export) implements the `FileSystem` operations on one remote host through the shared [`ctx.ssh`](../ssh/README.md) connection pool. [`@deepseek-ai/dsh-fs-routing`](../fs-routing/README.md) constructs one instance per host key and routes `ssh://` workspaces to it; the class also mounts standalone through its `static inject = ['ssh']`.

## Behavior

- **Resolution** — `resolve(path, { cwd })` takes its host from an `ssh://` cwd, an `ssh://` path, or the construction-time host hint, in that order, resolves the remote path against the profile's remote cwd, and canonicalizes it on the host; the canonical remote path is the opaque `targetKey`.
- **One SFTP channel per operation** — every stat/read/write/list opens an SFTP session on the pooled client and closes it when the operation settles, so no channel state survives between calls.
- **Concurrent-write safety** — writes and edits serialize per target path through an internal lock chain; `writeText` honors `FsWriteIntent` expectations and `editText` applies literal string replacement with the same outcome vocabulary as the local backend.
- **Error mapping** — SFTP failures map to `FsError` codes (`FS_NOT_FOUND` for absent paths, `FS_IO_ERROR` otherwise) with the display path in the message, so the tool layer renders them like local failures.

## Model Experience

Indirectly, through `dsh-tool-fs` and `dsh-tool-fs-search`, which render remote reads, writes, edits, and listings exactly as local ones.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **No confinement** — the remote SSH account's authority is the only boundary; the local sandbox stack cannot confine SFTP operations and is bypassed for them.
- **No chunked streaming** — `streamText` reads the whole file and yields it as one chunk; incremental SFTP streaming is deferred until a consumer needs it.
- **No symlink-preserving copy or directory moves** — writes go through atomic whole-file replacement; recursive operations beyond `listDir` belong to callers.
