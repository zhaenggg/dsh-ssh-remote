/**
 * Remote spawn tests against a fake pool: spawn-level failures reject the
 * handle's `done` loud, and a successful exec channel collects bounded output.
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Client, SshPoolLike } from '@zhaeng/dsh-ssh'
import SshSubprocessRuntime from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

const SPAWN = {
  argv: ['echo', 'hi'],
  cwd: 'ssh://fake-host/tmp',
  stdio: {
    stdin: 'ignore',
    stdout: { maxBytes: 1024 },
    stderr: { maxBytes: 1024 },
  },
  graceMs: 100,
} as const

function runtime(pool: SshPoolLike): SshSubprocessRuntime {
  context = new Context()
  return new SshSubprocessRuntime(context, { pollMs: 20 }, pool)
}

describe('SshSubprocessRuntime', () => {
  it('rejects done loud when the pool knows no profile', async () => {
    const pool: SshPoolLike = {
      getClient: async (_hostKey?: string): Promise<never> => {
        throw new Error('dsh-ssh: no profile for fake-host. Known: ')
      },
      getCwd: () => '/remote/ws',
    }
    const handle = runtime(pool).spawn(SPAWN)
    await expect(handle.done).rejects.toThrow(/remote spawn failed: dsh-ssh: no profile for fake-host/)
  })

  it('rejects done loud when the connection itself fails', async () => {
    const pool: SshPoolLike = {
      getClient: async (_hostKey?: string): Promise<never> => {
        throw new Error('dsh-ssh: fake-host connection failed: ECONNREFUSED')
      },
      getCwd: () => '/remote/ws',
    }
    const handle = runtime(pool).spawn(SPAWN)
    await expect(handle.done).rejects.toThrow(/ECONNREFUSED/)
  })

  it('collects remote stdout and resolves the exit code', async () => {
    const pool: SshPoolLike = { getClient: async () => fakeClient('hi\n') as Client, getCwd: () => '/remote/ws' }
    const handle = runtime(pool).spawn(SPAWN)
    await expect(handle.done).resolves.toMatchObject({ exitCode: 0, signal: null })
    expect(handle.collected.stdout?.readFrom(0)).toMatchObject({ text: 'hi\n', lossy: false })
  })

  it('refuses terminal spawns until PTY support lands', async () => {
    await expect(runtime({ getClient: async () => fakeClient('') as Client, getCwd: () => '/remote/ws' }).spawnTerminal({
      argv: ['bash'], cwd: 'ssh://fake-host/tmp', rows: 24, cols: 80, graceMs: 100,
    })).rejects.toThrow(/spawnTerminal is not yet implemented/)
  })
})

/** Minimal exec-channel client: echoes `stdout` and closes with code 0. */
function fakeClient(stdout: string): unknown {
  return {
    exec(_command: string, cb: (err: Error | undefined, stream: unknown) => void): void {
      const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      stream.stderr = new EventEmitter()
      cb(undefined, stream)
      if (stdout.length > 0) stream.emit('data', Buffer.from(stdout, 'utf-8'))
      stream.emit('close', 0, null)
    },
  }
}
