/**
 * SSH/SFTP provider for the filesystem capability seam.
 * Paths, contents, and atomic staging files remain inside the remote host.
 * @module @deepseek-ai/dsh-fs-ssh
 */

import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { Client, SshPoolLike } from '@deepseek-ai/dsh-ssh'
import { hostKeyFromPath, isSshPath, parseSshPath } from '@deepseek-ai/dsh-ssh/paths'
import type { SFTPWrapper, Stats } from 'ssh2'

const BINARY_SAMPLE_BYTES = 8192

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

function decodeText(bytes: Uint8Array, displayPath: string): string {
  if (bytes.subarray(0, bytes.length < BINARY_SAMPLE_BYTES ? bytes.length : BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

function mapError(error: unknown, operation: string, displayPath: string): FsError {
  if (error instanceof FsError) return error
  const msg = error instanceof Error ? error.message : String(error)
  if (/no such file|not found|ENOENT/i.test(msg)) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (/permission denied|EACCES|EPERM/i.test(msg)) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${msg}`, 'FS_IO_ERROR', { cause: error })
}

function entryType(stats: Stats): FsInfo['type'] {
  if (stats.isFile()) return 'file'
  if (stats.isDirectory()) return 'directory'
  if (stats.isSymbolicLink()) return 'file'
  return 'other'
}

function entryVersion(stats: Stats): ReturnType<typeof FsVersion> {
  const facts = JSON.stringify([stats.uid, stats.gid, stats.size, stats.mode, stats.mtime])
  return FsVersion('ssh:' + createHash('sha256').update(facts).digest('hex'))
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let matches = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

type SftpOp<T> = (sftp: SFTPWrapper) => Promise<T>

function withSftp<T>(client: Client, operation: SftpOp<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
      if (err !== undefined) { reject(err); return }
      operation(sftp).then(
        (result) => { sftp.end(); resolve(result) },
        (error: unknown) => {
          sftp.end()
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  })
}

/** Remote filesystem backend sharing the SSH connection owned by `ctx.ssh`. */
export class SshFileSystem {
  static inject = ['ssh']

  /** Host identity when created for a specific remote by the routing backend. */
  private readonly hostHint: string | undefined
  private readonly _ctx: Context | undefined
  private readonly _sshService: SshPoolLike | undefined

  /** When used as a Cordis plugin (not through RoutingFileSystem), ctx triggers Service registration. */
  constructor(ctx: Context | undefined, hostHint?: string, sshService?: SshPoolLike) {
    this.hostHint = hostHint
    this._ctx = ctx
    this._sshService = sshService
  }

  private get sshClient(): SshPoolLike {
    if (this._sshService !== undefined) return this._sshService
    if (this._ctx !== undefined) return this._ctx.ssh
    throw new Error('SshFileSystem: no ctx or sshService')
  }

  private readonly locks = new Map<string, Promise<unknown>>()

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    // Host and remote base come from an ssh:// cwd (routing backend), an
    // ssh:// path, or this backend's construction-time host hint — in that order.
    const cwd = opts?.cwd
    const cwdIsSsh = cwd !== undefined && isSshPath(cwd)
    const pathIsSsh = isSshPath(path)
    const hostHint = cwdIsSsh ? hostKeyFromPath(cwd) : pathIsSsh ? hostKeyFromPath(path) : this.hostHint
    const baseRemote = cwdIsSsh
      ? parseSshPath(cwd).remotePath
      : pathIsSsh
        ? parseSshPath(path).remotePath
        : this.sshClient.getCwd(hostHint)
    const displayPath = posix.resolve(baseRemote, pathIsSsh ? parseSshPath(path).remotePath : path)
    const client: Client = await this.sshClient.getClient(hostHint)
    const canonical = await this.canonicalPath(client, displayPath)
    return { targetKey: FsTargetKey(canonical), displayPath }
  }

  processPath(target: FsTarget): string { return String(target.targetKey) }
  fileUrl(target: FsTarget): string { return `file://${String(target.targetKey)}` }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const parentKey = String(parent.targetKey)
    const childKey = String(child.targetKey)
    return parentKey === childKey || childKey.startsWith(parentKey + '/')
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const client = await this.sshClient.getClient(this.hostHint)
    try {
      return await withSftp(client, async (sftp) => {
        const stats = await sftpStat(sftp, String(target.targetKey))
        return { type: entryType(stats), version: entryVersion(stats), size: stats.size }
      })
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw mapError(error, 'stat', target.displayPath)
    }
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    const cwd = opts?.cwd
    const cwdIsSsh = cwd !== undefined && isSshPath(cwd)
    const pathIsSsh = isSshPath(path)
    const lstatHostHint = cwdIsSsh ? hostKeyFromPath(cwd) : pathIsSsh ? hostKeyFromPath(path) : this.hostHint
    const baseRemote = cwdIsSsh
      ? parseSshPath(cwd).remotePath
      : pathIsSsh
        ? parseSshPath(path).remotePath
        : this.sshClient.getCwd(lstatHostHint)
    const displayPath = posix.resolve(baseRemote, pathIsSsh ? parseSshPath(path).remotePath : path)
    const client = await this.sshClient.getClient(lstatHostHint)
    try {
      return await withSftp(client, async (sftp) => {
        const stats = await new Promise<Stats>((resolve, reject) => {
          sftp.lstat(displayPath, (err: Error | undefined, result: Stats) => {
            if (err !== undefined) reject(err)
            else resolve(result)
          })
        })
        return { type: entryType(stats), version: entryVersion(stats), size: stats.size }
      })
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw mapError(error, 'lstat', displayPath)
    }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    assertNotAborted(signal, 'read')
    const client = await this.sshClient.getClient(this.hostHint)
    try {
      return await withSftp(client, async (sftp) => {
        const data = await sftpReadFile(sftp, String(target.targetKey))
        return decodeText(new Uint8Array(data), target.displayPath)
      })
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath)
    }
  }

  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // Read whole file and yield as one chunk — full streaming over SFTP is complex
    const content = await this.readText(target, signal)
    return {
      [Symbol.asyncIterator]() {
        let done = false
        return {
          next(): Promise<IteratorResult<string>> {
            if (done) return Promise.resolve({ done: true, value: undefined })
            done = true
            return Promise.resolve({ done: false, value: content })
          },
        }
      },
    }
  }

  async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    assertNotAborted(signal, 'read')
    const client = await this.sshClient.getClient(this.hostHint)
    try {
      return await withSftp(client, async (sftp) => {
        const data = await sftpReadFile(sftp, String(target.targetKey))
        if (data.length > maxBytes) {
          throw new FsError(`cannot read "${target.displayPath}": file too large`, 'FS_TOO_LARGE')
        }
        return new Uint8Array(data)
      })
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      throw mapError(error, 'read', target.displayPath)
    }
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    assertNotAborted(signal, 'listDir')
    const client = await this.sshClient.getClient(this.hostHint)
    try {
      return await withSftp(client, async (sftp) => {
        const entries = await new Promise<FsDirEntry[]>((resolve, reject) => {
          sftp.readdir(String(target.targetKey), (err: Error | undefined, list) => {
            if (err !== undefined) reject(err)
            else resolve(list.map((e: { filename: string; attrs: Stats }) => {
              const parentPath: string = String(target.targetKey)
              const childPath = posix.join(parentPath, e.filename)
              return {
                name: e.filename,
                type: entryType(e.attrs),
                target: { targetKey: FsTargetKey(childPath), displayPath: target.displayPath + '/' + e.filename },
              }
            }))
          })
        })
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        return entries
      })
    } catch (error: unknown) {
      throw mapError(error, 'listDir', target.displayPath)
    }
  }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    assertNotAborted(signal, 'write')
    const client = await this.sshClient.getClient(this.hostHint)

    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(client, target)
      this.checkIntent(existing, expected, target)

      const version = await this.writeAtomic(client, target, content, existing, signal)
      const before = expected?.kind === 'replaceIfVersion'
        ? await this.readForDiff(client, target)
        : null
      const after = normalizeLineEndings(content)
      const operation: 'create' | 'update' = existing !== undefined ? 'update' : 'create'
      return { operation, version, before, after }
    })
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    assertNotAborted(signal, 'edit')
    const client = await this.sshClient.getClient(this.hostHint)

    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(client, target)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (entryType(existing) !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && entryVersion(existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(client, target)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(raw))
      const version = await this.writeAtomic(client, target, storage, existing, signal)
      return { version, before, after }
    })
  }

  // ── private helpers ──

  private async withLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve()
    const run = prior.then(op, op)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(key, tail)
    try { return await run }
    finally { if (this.locks.get(key) === tail) this.locks.delete(key) }
  }

  private async canonicalPath(client: Client, path: string): Promise<string> {
    try {
      return await sshExec(client, `realpath -m -- '${path.replace(/'/g, "'\\''")}'`)
    } catch {
      return posix.normalize(path)
    }
  }

  private async probe(client: Client, target: FsTarget): Promise<Stats | undefined> {
    try {
      return await withSftp(client, sftp => sftpStat(sftp, String(target.targetKey)))
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw mapError(error, 'stat', target.displayPath)
    }
  }

  private checkIntent(
    existing: Stats | undefined,
    expected: FsWriteIntent | undefined,
    target: FsTarget,
  ): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(
        `cannot overwrite existing "${target.displayPath}" without reading it first`,
        'FS_NOT_OBSERVED',
      )
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || entryVersion(existing) !== expected.version) {
        throw new FsError(
          `cannot write "${target.displayPath}": file changed since it was read`,
          'FS_STALE_VERSION',
        )
      }
    }
  }

  private async readForDiff(client: Client, target: FsTarget): Promise<string | null> {
    try {
      const data = await withSftp(client, sftp => sftpReadFile(sftp, String(target.targetKey)))
      return normalizeLineEndings(decodeText(new Uint8Array(data), target.displayPath))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw mapError(error, 'read', target.displayPath)
    }
  }

  private async readForEdit(client: Client, target: FsTarget): Promise<string> {
    const data = await withSftp(client, sftp => sftpReadFile(sftp, String(target.targetKey)))
    return decodeText(new Uint8Array(data), target.displayPath)
  }

  private async writeAtomic(
    client: Client,
    target: FsTarget,
    content: string,
    _existing: Stats | undefined,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof FsVersion>> {
    assertNotAborted(signal, 'write')
    const targetPath = String(target.targetKey)

    return withSftp(client, async (sftp) => {
      await new Promise<void>((resolve, reject) => {
        sftp.writeFile(targetPath, content, (err?: Error | null) => {
          if (err != null) reject(err)
          else resolve()
        })
      })

      const stats = await sftpStat(sftp, targetPath)
      return entryVersion(stats)
    })
  }
}

// ── SFTP helpers ──

function sftpStat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err: Error | undefined, result: Stats) => {
      if (err !== undefined) reject(err)
      else resolve(result)
    })
  })
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, {}, (err: Error | undefined, data: Buffer) => {
      if (err !== undefined) reject(err)
      else resolve(data)
    })
  })
}

function isNotFound(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /no such file|not found|ENOENT/i.test(msg)
}

function sshExec(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err !== undefined) { reject(err); return }
      let stdout = ''
      let stderr = ''
      stream.on('data', (data: Buffer) => { stdout += data.toString('utf-8') })
      stream.stderr.on('data', (data: Buffer) => { stderr += data.toString('utf-8') })
      stream.on('close', (code: number | null) => {
        if (code !== 0 && code !== null) reject(new Error(stderr || `exit ${code}`))
        else resolve(stdout.trim())
      })
    })
  })
}

export default SshFileSystem
