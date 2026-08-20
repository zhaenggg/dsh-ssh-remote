/**
 * Pool and path-vocabulary tests. Connections never leave localhost's closed
 * port 1, so every connect path is a fast loud failure.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SshRuntime from '../src/index.ts'
import { buildSshPath, hostKeyFromPath, isSshPath, parseSshPath } from '../src/paths.ts'

let context: Context | undefined

afterEach(async () => {
  const raw = process.env.DSH_SSH_PROFILES
  if (raw !== undefined) {
    process.env.DSH_SSH_PROFILES = raw
  } else {
    delete process.env.DSH_SSH_PROFILES
  }
  await context?.fiber.dispose()
  context = undefined
})

describe('ssh path vocabulary', () => {
  it('round-trips buildSshPath through parseSshPath', () => {
    const path = buildSshPath('192.168.21.250:8322', '/home/zz/proj')
    expect(path).toBe('ssh://192.168.21.250:8322/home/zz/proj')
    expect(isSshPath(path)).toBe(true)
    expect(parseSshPath(path)).toEqual({ host: '192.168.21.250:8322', remotePath: '/home/zz/proj', raw: path })
  })

  it('keeps host:port whole in the host key and trims a trailing slash', () => {
    expect(buildSshPath('example.com', '/ws/')).toBe('ssh://example.com/ws')
    expect(hostKeyFromPath('ssh://example.com/x')).toBe('example.com')
    expect(hostKeyFromPath('ssh://example.com:2222/x')).toBe('example.com:2222')
    expect(hostKeyFromPath('/plain/local')).toBeUndefined()
  })

  it('rejects non-ssh and rootless paths', () => {
    expect(isSshPath('/local/path')).toBe(false)
    expect(isSshPath('file:///x')).toBe(false)
    expect(() => parseSshPath('ssh://host-only')).toThrow(/missing remote absolute path/)
  })
})

describe('SshRuntime pool', () => {
  it('fails loud when no profile exists', async () => {
    context = new Context()
    await context.plugin(SshRuntime, { host: '', username: '' })
    await expect(context.ssh.getClient()).rejects.toThrow(/no profiles configured/)
  })

  it('names the known profiles when the requested host is missing', async () => {
    process.env.DSH_SSH_PROFILES = JSON.stringify([
      { host: 'known-host', port: 22, username: 'u', password: 'p', cwd: '/remote' },
    ])
    context = new Context()
    await context.plugin(SshRuntime, { host: '', username: '' })
    await expect(context.ssh.getClient('other-host:22')).rejects.toThrow(/no profile for other-host:22\. Known: known-host/)
  })

  it('keeps configured profiles when DSH_SSH_PROFILES is malformed', async () => {
    process.env.DSH_SSH_PROFILES = '{not json'
    context = new Context()
    await context.plugin(SshRuntime, { host: 'row-host', username: 'u', password: 'p' })
    await expect(context.ssh.getClient('absent')).rejects.toThrow(/Known: row-host/)
  })

  it('rejects a connection to a closed local port with the underlying failure', async () => {
    context = new Context()
    await context.plugin(SshRuntime, {
      host: '127.0.0.1', port: 1, username: 'u', password: 'p', connectTimeoutMs: 500,
    })
    await expect(context.ssh.getClient('127.0.0.1:1')).rejects.toThrow(/127\.0\.0\.1 connection failed/)
  })

  it('answers the remote roots from the profile', async () => {
    context = new Context()
    await context.plugin(SshRuntime, { host: 'h', username: 'u', password: 'p', cwd: '/remote/ws' })
    expect(context.ssh.getCwd('h')).toBe('/remote/ws')
    expect(context.ssh.getRuntimeRoot('h')).toBe('/remote/ws/.dsh-ssh')
  })
})
