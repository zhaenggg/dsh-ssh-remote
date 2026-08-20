/**
 * The routed shell executor for local + ssh:// workspaces.
 * @module @zhaeng/dsh-fs-routing/shell
 */

import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellProcess, ShellRunResult, ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { isSshPath } from '@zhaeng/dsh-ssh/paths'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { RoutingFsConfig, RoutingSubprocessRuntime } from './index.ts'

/** Mirror of the wrapped local executor's budgets for remote spawns. */
const REMOTE_DEFAULTS = {
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 64_000,
  graceMs: 3_000,
}

/** Collect the full retained text of one collected stream. */
function collectedText(read: SubprocessHandle['collected']['stdout'], label: string): { text: string; truncated: boolean } {
  if (read === undefined) throw new Error('fs-routing: remote spawn dropped its ' + label + ' collect stream')
  const full = read.readFrom(0)
  return { text: full.text, truncated: full.lossy }
}

/**
 * The routed shell executor, registered as `ctx.shell`. Local workdirs run on
 * the wrapped sandboxing local executor with its confinement intact. An
 * `ssh://` workdir runs `bash -c` on the remote host through the ROUTING
 * subprocess runtime captured at construction — no service is resolved from
 * `ctx` at call time, because a service method's `this.ctx` is trace-remapped
 * to the calling context, where the needed injects are absent. A remote
 * command already carries the SSH account's full authority on that host, so
 * the local sandbox runner — which can only confine local processes — is
 * bypassed for it.
 */
export class RoutingShellExecutor extends ShellExecutor {
  private readonly local: SandboxBashExecutor
  private readonly subprocess: RoutingSubprocessRuntime

  constructor(ctx: Context, subprocess: RoutingSubprocessRuntime, config: RoutingFsConfig = {}) {
    super(ctx)
    this.subprocess = subprocess
    this.local = new SandboxBashExecutor(ctx.isolate('shell'), {
      cwd: config.cwd ?? process.cwd(),
      timeoutMs: REMOTE_DEFAULTS.timeoutMs,
      maxTimeoutMs: REMOTE_DEFAULTS.maxTimeoutMs,
      maxOutputBytes: REMOTE_DEFAULTS.maxOutputBytes,
      maxSpillBytes: 64 * 1024 * 1024,
      graceMs: REMOTE_DEFAULTS.graceMs,
    })
  }

  /** The wrapped executor's default — the capability fact the tool layer advertises. */
  override get sandboxMode(): SandboxBashExecutor['sandboxMode'] {
    return this.local.sandboxMode
  }

  private remoteSpawnSpec(spec: ShellExecSpec, signal: AbortSignal | undefined): SubprocessSpawnSpec {
    return {
      argv: ['bash', '-c', spec.command],
      cwd: spec.workdir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: spec.stdoutMaxBytes },
        stderr: { maxBytes: REMOTE_DEFAULTS.maxOutputBytes },
      },
      graceMs: REMOTE_DEFAULTS.graceMs,
      ...signal !== undefined ? { signal } : {},
      ...spec.env !== undefined || spec.dshEnv !== undefined
        ? { env: { ...spec.env, ...spec.dshEnv } }
        : {},
    }
  }

  private routed(spec: ShellExecSpec): ShellExecSpec {
    if (!isSshPath(spec.workdir)) return spec
    return { ...spec, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: spec.workdir } }
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return this.routed(this.local.resolve(request))
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    if (!isSshPath(spec.workdir)) return this.local.run(spec)
    if (spec.stdin !== undefined) {
      throw new Error('fs-routing: remote commands do not support stdin yet')
    }
    // One deadline fuses the spec timeout and upstream cancellation, mirroring
    // the local executor's foreground lifecycle.
    const controller = new AbortController()
    // Object-held so the timer callback's assignment is visible at the read
    // (a bare let narrows to its initializer under control-flow analysis).
    const state = { timedOut: false }
    const timer = setTimeout(() => {
      state.timedOut = true
      controller.abort(new Error('timeout'))
    }, spec.timeoutMs)
    const forwardAbort = (): void => { controller.abort(new Error('aborted')) }
    spec.signal?.addEventListener('abort', forwardAbort, { once: true })
    let handle: SubprocessHandle
    try {
      handle = this.subprocess.spawn(this.remoteSpawnSpec(spec, controller.signal))
    } catch (error: unknown) {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', forwardAbort)
      throw error
    }
    let outcome: SubprocessOutcome
    try {
      outcome = await handle.done
    } finally {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', forwardAbort)
    }
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: state.timedOut,
      aborted: !state.timedOut && spec.signal?.aborted === true,
      timeoutMs: spec.timeoutMs,
      stdout: collectedText(handle.collected.stdout, 'stdout'),
      stderr: collectedText(handle.collected.stderr, 'stderr'),
    }
  }

  override start(spec: ShellExecSpec): ShellProcess {
    if (!isSshPath(spec.workdir)) return this.local.start(spec)
    const running = this.subprocess.spawn(this.remoteSpawnSpec(spec, spec.signal))
    const stdoutReader = running.collected.stdout
    const stderrReader = running.collected.stderr
    let stdoutOffset = 0
    let stderrOffset = 0
    const proc: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then((outcome) => {
        if (proc.status === 'running') {
          proc.status = spec.signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
      }, (error: unknown) => {
        proc.status = 'killed'
        proc.exitCode = null
        void error
      }),
      readOutput: (): { delta: string; lossy: boolean } => {
        const out = stdoutReader?.readFrom(stdoutOffset)
        const err = stderrReader?.readFrom(stderrOffset)
        const outText = out?.text ?? ''
        const errText = err?.text ?? ''
        stdoutOffset = out?.nextOffset ?? stdoutOffset
        stderrOffset = err?.nextOffset ?? stderrOffset
        const separator = outText.length > 0 && !outText.endsWith('\n') ? '\n' : ''
        const delta = outText + (errText.length > 0 ? separator + '[stderr]\n' + errText : '')
        return { delta, lossy: (out?.lossy ?? false) || (err?.lossy ?? false) }
      },
      kill: (): boolean => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running.terminate()
        return true
      },
    }
    return proc
  }
}
