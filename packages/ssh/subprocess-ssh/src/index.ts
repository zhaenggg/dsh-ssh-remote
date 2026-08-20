/**
 * SSH Service Provider for the subprocess capability seam.
 * Each handle starts through the shared SSH connection and executes on the remote host.
 * @module @zhaenggg/dsh-subprocess-ssh
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SENSITIVE_ENV_PATTERN, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
// Pull in ctx.ssh augmentation
import type {} from '@zhaenggg/dsh-ssh'
import type { Client, SshPoolLike } from '@zhaenggg/dsh-ssh'
import { hostKeyFromPath, isSshPath, parseSshPath } from '@zhaenggg/dsh-ssh/paths'

/** Configuration for the SSH subprocess adapter. */
export interface Config {
  pollMs?: number
}

const MAX_TIMER_MS = 2_147_483_647

function isCollect(mode: SubprocessSpawnSpec['stdio']['stdout']): mode is SubprocessCollect {
  return typeof mode === 'object'
}

function collectCap(mode: SubprocessSpawnSpec['stdio']['stdout']): number {
  return isCollect(mode) ? mode.maxBytes : 1024 * 1024
}

function appendTail(state: { text: string; dropped: number }, chunk: string, cap: number): void {
  const next = state.text + chunk
  if (next.length <= cap) {
    state.text = next
    return
  }
  state.text = next.slice(next.length - cap)
  state.dropped = next.length - cap + state.dropped
}

function validateGrace(graceMs: number): void {
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_MS) {
    throw new Error('subprocess graceMs must be a positive finite number no greater than ' + String(MAX_TIMER_MS))
  }
}

/** Whole-stream-offset reader over one bounded in-memory remote stream tail. */
class SshOutputReader implements SubprocessOutputReader {
  constructor(private readonly state: { text: string; dropped: number }) {}
  readFrom(fromByte: number): SubprocessOutputRead {
    const { text, dropped } = this.state
    if (fromByte < dropped) {
      return { text, nextOffset: dropped + text.length, lossy: true }
    }
    const offset = fromByte - dropped
    return { text: offset >= text.length ? '' : text.slice(offset), nextOffset: dropped + text.length, lossy: false }
  }
}

class SshSubprocessHandle implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly done: Promise<SubprocessOutcome>

  private readonly outState = { text: '', dropped: 0 }
  private readonly errState = { text: '', dropped: 0 }
  readonly collected: SubprocessHandle['collected']

  private remotePid = -1
  private readonly doneResolve: (outcome: SubprocessOutcome) => void
  private readonly doneReject: (error: Error) => void

  private readonly outCap: number
  private readonly errCap: number

  constructor(
    client: Client | Promise<Client>,
    spec: SubprocessSpawnSpec,
  ) {
    const { promise, resolve, reject } = Promise.withResolvers<SubprocessOutcome>()
    this.done = promise
    this.doneResolve = resolve
    this.doneReject = reject

    this.outCap = collectCap(spec.stdio.stdout)
    this.errCap = collectCap(spec.stdio.stderr)
    this.collected = {
      ...(isCollect(spec.stdio.stdout) ? { stdout: new SshOutputReader(this.outState) } : {}),
      ...(isCollect(spec.stdio.stderr) ? { stderr: new SshOutputReader(this.errState) } : {}),
    }

    spec.signal?.addEventListener('abort', () => { this.terminate() }, { once: true })

    // Start the command asynchronously
    const remoteCwd = isSshPath(spec.cwd) ? parseSshPath(spec.cwd).remotePath : spec.cwd
    const envEntries = buildEnvString(spec.env)
    const quotedArgv = spec.argv.map((arg) => {
      const escaped = arg.replace(/'/g, "'\\''")
      return "'" + escaped + "'"
    }).join(' ')

    const command = envEntries.length > 0
      ? "cd '" + remoteCwd.replace(/'/g, "'\\''") + "' && env " + envEntries.join(' ') + ' ' + quotedArgv
      : "cd '" + remoteCwd.replace(/'/g, "'\\''") + "' && " + quotedArgv

    void this.start(client, command)
  }

  get pid(): number {
    return this.remotePid
  }

  private stream: { close: () => void } | undefined

  terminate(): void {
    // Closing the channel ends the remote command's stream; the close handler settles done.
    this.stream?.close()
  }

  async waitForExit(_signal?: AbortSignal): Promise<boolean> {
    try {
      const outcome = await this.done
      return outcome.exitCode !== null
    } catch {
      return true
    }
  }

  private async start(clientInput: Client | Promise<Client>, command: string): Promise<void> {
    let client: Client
    try {
      client = await clientInput
    } catch (error: unknown) {
      // A connection/pool failure is a spawn-level failure: reject done loud
      // (the seam contract) instead of masking it as a SIGTERM exit.
      this.doneReject(error instanceof Error
        ? new Error('dsh-subprocess-ssh: remote spawn failed: ' + error.message, { cause: error })
        : new Error('dsh-subprocess-ssh: remote spawn failed'))
      return
    }
    return new Promise<void>((resolve, reject) => {
      client.exec(command, (err: Error | undefined, stream) => {
        if (err !== undefined) {
          this.doneReject(err)
          reject(err)
          return
        }

        this.stream = stream

        stream.on('data', (data: Buffer) => {
          appendTail(this.outState, data.toString('utf-8'), this.outCap)
        })

        stream.stderr.on('data', (data: Buffer) => {
          appendTail(this.errState, data.toString('utf-8'), this.errCap)
        })

        stream.on('close', (code: number | null, _signal: string | null) => {
          resolve()
          this.doneResolve({
            exitCode: code,
            signal: null,
          })
        })

        stream.on('error', (err2: Error) => {
          reject(err2)
          this.doneReject(err2)
        })

        resolve()
      })
    })
  }
}

/** SSH command manager registered as `ctx.subprocess`. */
export class SshSubprocessRuntime extends SubprocessRuntime {
  static inject = ['ssh']

  static Config: z<Config> = z.object({
    pollMs: z.number().default(20),
  })

  private readonly live = new Set<SshSubprocessHandle>()
  private readonly terminals = new Set<SubprocessTerminalHandle>()
  private disposing = false
  /** Explicit pool from the routing backend: `this.ctx.ssh` is trace-remapped to the calling context, where 'ssh' is not injected. */
  private readonly sshPool: SshPoolLike | undefined

  constructor(ctx: Context, config: Config, sshPool?: SshPoolLike) {
    super(ctx)
    this.sshPool = sshPool
    // pollMs validated but reserved for future use
    void (config.pollMs)

    ctx.effect(() => async () => {
      this.disposing = true
      const handles = [...this.live]
      const terms = [...this.terminals]
      const pending: Promise<unknown>[] = []
      for (const handle of handles) {
        pending.push(handle.waitForExit().then(() => this.live.delete(handle)))
      }
      for (const terminal of terms) {
        pending.push(terminal.terminate().catch(() => {}).then(() => this.terminals.delete(terminal)))
      }
      await Promise.allSettled(pending)
    }, 'ssh subprocess teardown')
  }

  override async resolveExecutable(
    command: string,
    _env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.includes('/')) {
      throw new Error(
        'subprocess-ssh: relative paths containing separators are not supported: "' + command + '"',
      )
    }
    const client = await (this.sshPool ?? this.ctx.ssh).getClient()
    return new Promise((resolve, reject) => {
      const abortHandler = (): void => { reject(new Error('resolveExecutable aborted')) }
      signal?.addEventListener('abort', abortHandler, { once: true })
      const escaped = command.replace(/'/g, "'\\''")
      client.exec("command -v '" + escaped + "'", (err: Error | undefined, stream) => {
        if (err !== undefined) {
          signal?.removeEventListener('abort', abortHandler)
          reject(err)
          return
        }
        let stdout = ''
        stream.on('data', (data: Buffer) => { stdout += data.toString('utf-8') })
        stream.on('close', (code: number | null) => {
          signal?.removeEventListener('abort', abortHandler)
          const found = stdout.trim()
          if (code === 0 && found.length > 0) {
            resolve(found)
          } else {
            reject(new Error('subprocess-ssh: executable not found: ' + command))
          }
        })
      })
    })
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing) throw new Error('subprocess-ssh: service is disposing')
    validateGrace(spec.graceMs)

    const hostKey = hostKeyFromPath(spec.cwd)
    const handle = new SshSubprocessHandle((this.sshPool ?? this.ctx.ssh).getClient(hostKey), spec)
    this.live.add(handle)
    // Live-set cleanup chain only: the rejection itself is delivered to
    // the handle's consumers, so this tail catches the passthrough copy.
    void handle.done.finally(() => this.live.delete(handle)).catch(() => {})
    return handle
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error(
      'subprocess-ssh: spawnTerminal is not yet implemented. '
      + 'Terminal PTY sessions over SSH require additional implementation.',
    ))
  }
}

function buildEnvString(env?: Readonly<NodeJS.ProcessEnv>): string[] {
  if (env === undefined) return []
  const entries: [string, string][] = []
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) entries.push([key, value])
  }
  if (entries.length === 0) return []
  return entries
    .filter(([key]) => !SENSITIVE_ENV_PATTERN.test(key))
    .map(([key, value]) => {
      const escapedKey = key
      const escapedValue = value.replace(/'/g, "'\\''")
      return escapedKey + "='" + escapedValue + "'"
    })
}

export default SshSubprocessRuntime
