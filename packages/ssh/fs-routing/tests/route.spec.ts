/**
 * Routing-key unit tests: backend discrimination, round-trip, and host capture
 * without any live SSH connection. Pure helpers, no Cordis context required.
 */

import { describe, expect, it } from 'vitest'
import {
  LOCAL_PREFIX, SSH_PREFIX,
  parseRoutingKey, localKey, sshKey, isRoutingTarget, hostKeyOfCwd,
  wrapLocalTarget, wrapSshTarget,
} from '../src/route.ts'

describe('parseRoutingKey', () => {
  it('round-trips a local key', () => {
    const key = localKey('/home/me/repo/src/read.ts')
    expect(key).toMatch(new RegExp('^' + LOCAL_PREFIX))
    expect(isRoutingTarget(key)).toBe(true)
    const parsed = parseRoutingKey(key)
    expect(parsed).not.toBeNull()
    expect(parsed?.kind).toBe('local')
    expect(parsed?.hostKey).toBe('')
    expect(parsed?.inner).toBe('/home/me/repo/src/read.ts')
  })

  it('round-trips an ssh key with a host key', () => {
    const key = sshKey('192.168.21.250:8322', '/remote/path/file.c')
    expect(key.startsWith(SSH_PREFIX)).toBe(true)
    expect(isRoutingTarget(key)).toBe(true)
    const parsed = parseRoutingKey(key)
    expect(parsed).not.toBeNull()
    expect(parsed?.kind).toBe('ssh')
    expect(parsed?.hostKey).toBe('192.168.21.250:8322')
    expect(parsed?.inner).toBe('/remote/path/file.c')
  })

  it('rejects a foreign key', () => {
    expect(parseRoutingKey('/plain/local/path')).toBeNull()
    expect(parseRoutingKey('route:unknown:x')).toBeNull()
    expect(isRoutingTarget('anything-else')).toBe(false)
  })

  it('wrap helpers mint routing targets', () => {
    const local = wrapLocalTarget('/x', '/sub')
    expect(local.displayPath).toBe('/x')
    expect(parseRoutingKey(String(local.targetKey))?.inner).toBe('/sub')

    const ssh = wrapSshTarget('h:22', '/remote', '/deep')
    expect(ssh.displayPath).toBe('/remote')
    const p = parseRoutingKey(String(ssh.targetKey))
    expect(p?.kind).toBe('ssh')
    expect(p?.hostKey).toBe('h:22')
    expect(p?.inner).toBe('/deep')
  })
})

describe('hostKeyOfCwd', () => {
  it('derives a host key from an ssh cwd', () => {
    expect(hostKeyOfCwd('ssh://192.168.21.250:8322/home/zz/proj')).toBe('192.168.21.250:8322')
  })
  it('returns undefined for local and undefined cwds', () => {
    expect(hostKeyOfCwd('/home/zz/proj')).toBeUndefined()
    expect(hostKeyOfCwd(undefined)).toBeUndefined()
  })
})
