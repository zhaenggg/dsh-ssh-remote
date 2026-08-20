/**
 * Routing backends for the filesystem and subprocess capability seams.
 * @module @zhaeng/dsh-fs-routing
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SshFileSystem } from '@zhaeng/dsh-fs-ssh'
export { RoutingShellExecutor } from './shell.ts'
import { RoutingShellExecutor } from './shell.ts'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SshSubprocessRuntime } from '@zhaeng/dsh-subprocess-ssh'
import type { SshPoolLike } from '@zhaeng/dsh-ssh'
import { FsTargetKey, FileSystem, FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo,
  FsTarget, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { hostKeyFromPath } from '@zhaeng/dsh-ssh/paths'
import { parseRoutingKey, localKey, sshKey } from './route.ts'

export interface RoutingFsConfig {
  cwd?: string
}

export const RoutingFsConfig: z<RoutingFsConfig> = z.object({
  cwd: z.string(),
})

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw new FsError(operation + ' aborted', 'FS_ABORTED')
}

export class RoutingFileSystem extends FileSystem {
  private readonly local: SandboxedFileSystem
  private readonly sshBackends = new Map<string, SshFileSystem>()
  private readonly sshPool: SshPoolLike | undefined

  constructor(ctx: Context, config: RoutingFsConfig = {}, sshPool?: SshPoolLike) {
    super(ctx)
    this.sshPool = sshPool
    this.local = new SandboxedFileSystem(ctx.isolate('fs'), {
      cwd: config.cwd ?? process.cwd(),
      diffBasisMaxBytes: 10 * 1024 * 1024,
    })
    ctx.effect(() => () => { this.sshBackends.clear() }, 'fs-routing ssh clear')
  }

  private sshFor(hostKey: string): SshFileSystem {
    let backend = this.sshBackends.get(hostKey)
    if (backend === undefined) {
      backend = new SshFileSystem(this.ctx.isolate('fs'), hostKey, this.sshPool)
      this.sshBackends.set(hostKey, backend)
    }
    return backend
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('empty path', 'FS_NOT_FOUND')

    // Consumers that join an ssh:// cwd with node:path lose the scheme and
    // prefix the launch cwd (…/ssh:/host:port/remote/path). Recover the ssh://
    // form from such a mashed absolute path so the remote backend still resolves it.
    let hostKey = hostKeyFromPath(opts?.cwd ?? '')
    let effectiveCwd = opts?.cwd
    if (hostKey === undefined && path.startsWith('/')) {
      const sshMarker = path.indexOf('/ssh:/')
      if (sshMarker >= 0) {
        let sshPart = path.slice(sshMarker + 1)
        if (sshPart.startsWith('ssh:/') && !sshPart.startsWith('ssh://')) {
          sshPart = 'ssh://' + sshPart.slice(5)
        }
        const hk = hostKeyFromPath(sshPart)
        if (hk !== undefined) {
          hostKey = hk
          effectiveCwd = sshPart.slice(0, sshPart.lastIndexOf('/') + 1)
          path = './' + sshPart.slice(sshPart.lastIndexOf('/') + 1)
        }
      }
    }

    hostKey = hostKey ?? hostKeyFromPath(opts?.cwd ?? path)
    if (hostKey !== undefined) {
      const sshOpts = effectiveCwd !== undefined && effectiveCwd !== opts?.cwd ? { ...opts, cwd: effectiveCwd } : opts
      const inner = await this.sshFor(hostKey).resolve(path, sshOpts)
      return { targetKey: sshKey(hostKey, String(inner.targetKey)) as unknown as FsTargetKey, displayPath: inner.displayPath }
    }
    const inner = await this.local.resolve(path, opts)
    return { targetKey: localKey(inner.targetKey) as unknown as FsTargetKey, displayPath: inner.displayPath }
  }

  private route<T>(target: FsTarget, ssh: (hk: string, t: FsTarget) => T, local: (t: FsTarget) => T): T {
    const parsed = parseRoutingKey(String(target.targetKey))
    if (!parsed) return local(target)
    const inner: FsTarget = { targetKey: parsed.inner as unknown as FsTargetKey, displayPath: target.displayPath }
    return parsed.kind === 'ssh' ? ssh(parsed.hostKey, inner) : local(inner)
  }

  override async stat(t: FsTarget, s?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(s, 'stat')
    return this.route(t, (hk, ti) => this.sshFor(hk).stat(ti, s), ti => this.local.stat(ti, s))
  }
  override async readText(t: FsTarget, s?: AbortSignal): Promise<string> {
    assertNotAborted(s, 'readText')
    return this.route(t, (hk, ti) => this.sshFor(hk).readText(ti, s), ti => this.local.readText(ti, s))
  }
  override async writeText(
    t: FsTarget,
    c: string,
    e?: FsWriteIntent,
    s?: AbortSignal,
    p?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return this.route(t, (hk, ti) => this.sshFor(hk).writeText(ti, c, e, s), ti => this.local.writeText(ti, c, e, s, p))
  }
  override async editText(
    t: FsTarget,
    ed: FsEditRequest,
    e?: { version: FsVersion },
    s?: AbortSignal,
    p?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return this.route(t, (hk, ti) => this.sshFor(hk).editText(ti, ed, e, s), ti => this.local.editText(ti, ed, e, s, p))
  }
  override async listDir(t: FsTarget, s?: AbortSignal): Promise<FsDirEntry[]> {
    assertNotAborted(s, 'listDir')
    return this.route(t, (hk, ti) => this.sshFor(hk).listDir(ti, s), ti => this.local.listDir(ti, s))
  }
  override async readBytes(t: FsTarget, s?: AbortSignal): Promise<Uint8Array> {
    assertNotAborted(s, 'readBytes')
    return this.route(t, (hk, ti) => this.sshFor(hk).readBytes(ti, s, 10*1024*1024), ti => this.local.readBytes(ti, s, 10*1024*1024))
  }
  override async streamText(t: FsTarget, s?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.route(t, (hk, ti) => this.sshFor(hk).streamText(ti, s), ti => this.local.streamText(ti, s))
  }

  override get sandboxMode() { return this.local.sandboxMode }
  override processPath(target: FsTarget): string { return target.displayPath }
  override fileUrl(_target: FsTarget): string { return '' }
  override contains(_parent: FsTarget, _child: FsTarget): boolean { return false }
  override lstat(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsPathInfo | undefined> {
    const hk = hostKeyFromPath(opts?.cwd ?? path)
    if (hk !== undefined) return this.sshFor(hk).lstat(path, opts)
    return this.local.lstat(path, opts)
  }
}

export class RoutingSubprocessRuntime extends SubprocessRuntime {
  private readonly local: LocalSubprocessRuntime
  private readonly sshBackends = new Map<string, SshSubprocessRuntime>()
  private readonly sshPool: SshPoolLike | undefined

  constructor(ctx: Context, sshPool?: SshPoolLike) {
    super(ctx)
    this.sshPool = sshPool
    this.local = new LocalSubprocessRuntime(this.ctx.isolate('subprocess'))
  }

  private host(cwd: string | undefined): LocalSubprocessRuntime | SshSubprocessRuntime {
    const hk = cwd !== undefined ? hostKeyFromPath(cwd) : undefined
    if (hk !== undefined) return this.sshFor(hk)
    return this.local
  }
  private sshFor(hostKey: string): SshSubprocessRuntime {
    let b = this.sshBackends.get(hostKey)
    if (b === undefined) {
      b = new SshSubprocessRuntime(this.ctx.isolate('subprocess'), { pollMs: 20 }, this.sshPool)
      this.sshBackends.set(hostKey, b)
    }
    return b
  }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle { return this.host(spec.cwd).spawn(spec) }
  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return this.host(spec.cwd).spawnTerminal(spec)
  }
  override async resolveExecutable(
    command: string,
    env?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.host(undefined).resolveExecutable(command, env, signal)
  }
}

export const name = 'fs-routing'
export const inject = ['ssh', 'sandboxPolicy', 'sandbox']

export function apply(ctx: Context, config: Record<string, unknown> = {}): void {
  // Capture the ssh pool here, while this fiber's inject guarantees
  // resolution: a service method's `this.ctx` is trace-remapped to the CALLING
  // context, where 'ssh' is not injected and property access would throw.
  const ssh = ctx.ssh
  new RoutingFileSystem(ctx, config, ssh)
  const subprocess = new RoutingSubprocessRuntime(ctx, ssh)
  new RoutingShellExecutor(ctx, subprocess, config)
}
