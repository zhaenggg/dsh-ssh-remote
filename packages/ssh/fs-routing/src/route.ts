/**
 * Shared routing identity helpers for the routing backends. A resolved
 * `FsTarget` from the routing filesystem carries a `targetKey` prefixed with a
 * stable backend discriminator so downstream operations (stat/read/list/...)
 * can route back to the exact sub-backend that produced it without inspecting
 * the opaque model-facing path.
 * @module @zhaenggg/dsh-fs-routing/route
 */

import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import { hostKeyFromPath, isSshPath } from '@zhaenggg/dsh-ssh/paths'

/** Prefix for local-backend targets. */
export const LOCAL_PREFIX = 'route:local:'
/** Prefix for ssh-backend targets, followed by the host key and a ':' then the inner path. */
export const SSH_PREFIX = 'route:ssh:'
/**
 * Separator between the host key and the inner remote path inside an ssh
 * routing key. `\n` is chosen because host keys (`host`/`host:port`) and
 * absolute remote paths can never contain a newline.
 */
const HOST_SEP = '\n'

/**
 * Parse a routing `targetKey` into (`kind`, `hostKey`, `inner`). Local targets
 * carry an empty hostKey. Returns null when the key is not one this backend
 * minted (a defensive guard used before delegating back).
 */
export function parseRoutingKey(key: string): { kind: 'local' | 'ssh'; hostKey: string; inner: string } | null {
  if (key.startsWith(LOCAL_PREFIX)) {
    return { kind: 'local', hostKey: '', inner: key.slice(LOCAL_PREFIX.length) }
  }
  if (key.startsWith(SSH_PREFIX)) {
    const rest = key.slice(SSH_PREFIX.length)
    const sep = rest.indexOf(HOST_SEP)
    if (sep < 0) return null
    return { kind: 'ssh', hostKey: rest.slice(0, sep), inner: rest.slice(sep + HOST_SEP.length) }
  }
  return null
}

export function localKey(inner: string): string {
  return LOCAL_PREFIX + inner
}

export function sshKey(hostKey: string, inner: string): string {
  return SSH_PREFIX + hostKey + HOST_SEP + inner
}

/** Build a routing `FsTarget` for a remote ssh path. */
export function wrapSshTarget(hostKey: string, displayPath: string, inner: string): { targetKey: FsTargetKey; displayPath: string } {
  return { targetKey: FsTargetKey(sshKey(hostKey, inner)), displayPath }
}

/** Build a routing `FsTarget` for a local path. */
export function wrapLocalTarget(displayPath: string, inner: string): { targetKey: FsTargetKey; displayPath: string } {
  return { targetKey: FsTargetKey(localKey(inner)), displayPath }
}

/** Derive the ssh host key from a workspace cwd, or undefined for a local cwd. */
export function hostKeyOfCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  if (isSshPath(cwd)) return hostKeyFromPath(cwd)
  return undefined
}

/** True when a target key was minted by the routing backend. */
export function isRoutingTarget(key: string): boolean {
  return key.startsWith(LOCAL_PREFIX) || key.startsWith(SSH_PREFIX)
}
