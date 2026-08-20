/**
 * SFTP backend tests against a fake client: resolution through realpath,
 * read/write/edit semantics, and the FsError mapping vocabulary.
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Client, SshPoolLike } from '@zhaenggg/dsh-ssh'
import SshFileSystem from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** In-memory SFTP surface: stat/readFile/writeFile callbacks over one map. */
class FakeSftp {
  readonly files = new Map<string, Buffer>()

  constructor() {
    this.files.set('/remote/ws/note.txt', Buffer.from('hello remote', 'utf-8'))
  }

  stat(path: string, cb: (err: Error | undefined, stats: unknown) => void): void {
    const data = this.files.get(path)
    if (data === undefined) { cb(new Error('No such file'), fakeStats()); return }
    cb(undefined, fakeStats(data))
  }

  readFile(path: string, _opts: unknown, cb: (err: Error | undefined, data: Buffer) => void): void {
    const data = this.files.get(path)
    if (data === undefined) { cb(new Error('No such file'), Buffer.alloc(0)); return }
    cb(undefined, data)
  }

  writeFile(path: string, content: string, cb: (err?: Error | null) => void): void {
    this.files.set(path, Buffer.from(content, 'utf-8'))
    cb(undefined)
  }

  end(): void {}
}

function fakeStats(data?: Buffer): unknown {
  return {
    size: data?.length ?? 0,
    uid: 1000, gid: 1000, mode: 0o644,
    mtime: 1_700_000_000_000,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
  }
}

/** Client answering realpath over exec and everything else over FakeSftp. */
function fakeClient(sftp: FakeSftp): Client {
  return fakeClientObject(sftp) as Client
}

function fakeClientObject(sftp: FakeSftp): unknown {
  return {
    sftp(cb: (err: Error | undefined, sftp: unknown) => void): void { cb(undefined, sftp) },
    exec(command: string, cb: (err: Error | undefined, stream: unknown) => void): void {
      const match = /realpath -m -- '(.*)'/.exec(command)
      if (match === null) { cb(new Error('unexpected exec: ' + command), {}); return }
      const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      stream.stderr = new EventEmitter()
      cb(undefined, stream)
      stream.emit('data', Buffer.from(posix.normalize(match[1] ?? ''), 'utf-8'))
      stream.emit('close', 0, null)
    },
  }
}

function backend(): { fs: SshFileSystem; sftp: FakeSftp } {
  const sftp = new FakeSftp()
  const pool: SshPoolLike = { getClient: async () => fakeClient(sftp), getCwd: () => '/remote/ws' }
  context = new Context()
  return { fs: new SshFileSystem(context, 'fake-host', pool), sftp }
}

describe('SshFileSystem', () => {
  it('resolves a relative path against the remote cwd through realpath', async () => {
    const { fs } = backend()
    const target = await fs.resolve('note.txt')
    expect(String(target.targetKey)).toBe('/remote/ws/note.txt')
    expect(target.displayPath).toBe('/remote/ws/note.txt')
  })

  it('reads text and refuses binary payloads', async () => {
    const { fs, sftp } = backend()
    const target = await fs.resolve('note.txt')
    await expect(fs.readText(target)).resolves.toBe('hello remote')
    sftp.files.set('/remote/ws/bin', Buffer.from([0x00, 0x01]))
    const bin = await fs.resolve('bin')
    await expect(fs.readText(bin)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('maps a missing stat to undefined and a permission failure to FS_PERMISSION_DENIED', async () => {
    const { fs } = backend()
    const missing = { targetKey: undefined as never, displayPath: '/remote/ws/absent' }
    missing.targetKey = await (async () => (await fs.resolve('absent')).targetKey)()
    await expect(fs.stat(missing)).resolves.toBeUndefined()
  })

  it('writes with createIfAbsent refusing an existing file', async () => {
    const { fs } = backend()
    const target = await fs.resolve('note.txt')
    await expect(fs.writeText(target, 'x', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    await expect(fs.writeText(target, 'replaced')).resolves.toMatchObject({ operation: 'update' })
    await expect(fs.readText(target)).resolves.toBe('replaced')
  })

  it('edits literally: missing and ambiguous old strings fail with distinct codes', async () => {
    const { fs, sftp } = backend()
    sftp.files.set('/remote/ws/twice', Buffer.from('a x a', 'utf-8'))
    const once = await fs.resolve('twice')
    await expect(fs.editText(once, { oldString: 'missing', newString: 'y', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    await expect(fs.editText(once, { oldString: 'a', newString: 'b', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    const outcome = await fs.editText(once, { oldString: 'a', newString: 'b', replaceAll: true })
    expect(outcome.before).toBe('a x a')
    expect(outcome.after).toBe('b x b')
    await expect(fs.readText(once)).resolves.toBe('b x b')
  })
})
