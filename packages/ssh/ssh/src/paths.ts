/**
 * Remote-path helpers: ssh://host/path parsing.
 * @module @zhaenggg/dsh-ssh/paths
 */

const PREFIX = 'ssh://'

export const SSH_PATH_PREFIX = PREFIX

export function isSshPath(path: string): boolean {
  return path.startsWith(PREFIX)
}

export interface SshRemotePath {
  host: string
  remotePath: string
  raw: string
}

export function parseSshPath(path: string): SshRemotePath {
  if (!path.startsWith(PREFIX)) {
    throw new Error('not an ssh:// path: ' + path)
  }
  const rest = path.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash < 0) {
    throw new Error('ssh:// path missing remote absolute path: ' + path)
  }
  const host = rest.slice(0, slash)
  const remotePath = rest.slice(slash)
  if (remotePath.length === 0 || remotePath === '/') {
    throw new Error('ssh:// path must include a non-root remote directory: ' + path)
  }
  return { host, remotePath, raw: path }
}

export function buildSshPath(host: string, remotePath: string): string {
  const normalized = remotePath.endsWith('/')
    ? remotePath.slice(0, -1)
    : remotePath
  return PREFIX + host + normalized
}

/** Extract host:port identity from an ssh:// path, usable as getClient(key). */
export function hostKeyFromPath(path: string): string | undefined {
  if (!path.startsWith(PREFIX)) return undefined
  const parsed = parseSshPath(path)
  return parsed.host
}
