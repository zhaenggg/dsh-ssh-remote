/**
 * REAL-composition test: boots a test-only cordis.yml through the Loader with
 * the ssh pool mounted but NO profiles, so the routing layer is local-only —
 * the exact shape the web-app bundle ships. Local reads and shell runs must
 * behave exactly as the single-backend providers did, and an ssh:// cwd must
 * fail loud through the pool instead of silently falling back to local.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SshRuntime from '@deepseek-ai/dsh-ssh'
import '@deepseek-ai/dsh-fs'
import '@deepseek-ai/dsh-shell'
import * as FsRouting from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class PassthroughSandbox extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

const suite = process.platform === 'win32' ? describe.skip : describe

suite('fs-routing real Loader composition through cordis.yml', () => {
  it('serves local workspaces and fails loud on ssh:// cwds without a profile', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-fs-routing-'))
    await writeFile(join(root, 'note.txt'), 'routed-local', 'utf-8')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-ssh'",
      '  config:',
      "    host: ''",
      "    username: ''",
      "- name: '@deepseek-ai/dsh-test-sandbox'",
      "- name: '@deepseek-ai/dsh-sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: ${JSON.stringify(root)}`,
      "- name: '@deepseek-ai/dsh-fs-routing'",
      '  config:',
      `    cwd: ${JSON.stringify(root)}`,
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-ssh', SshRuntime],
      ['@deepseek-ai/dsh-test-sandbox', PassthroughSandbox],
      ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
      ['@deepseek-ai/dsh-fs-routing', FsRouting],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    expect(context.fs).toBeInstanceOf(FsRouting.RoutingFileSystem)
    expect(context.shell).toBeInstanceOf(FsRouting.RoutingShellExecutor)

    const target = await context.fs.resolve('note.txt', { cwd: root })
    expect(String(target.targetKey)).toMatch(/^route:local:/)
    await expect(context.fs.readText(target)).resolves.toBe('routed-local')

    const result = await context.shell.run(context.shell.resolve({ command: 'echo routed-shell', workdir: root }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toContain('routed-shell')

    // An ssh:// cwd reaches the ssh backend's pool and a missing profile is
    // the loud failure, never a silent local fallback.
    await expect(context.fs.resolve('/etc/hosts', { cwd: 'ssh://no-such-host.invalid/tmp' }))
      .rejects.toThrow(/no profile for no-such-host\.invalid/)
    await expect(context.shell.run(context.shell.resolve({ command: 'true', workdir: 'ssh://no-such-host.invalid/tmp' })))
      .rejects.toThrow(/no profile for no-such-host\.invalid/)
  })
})
