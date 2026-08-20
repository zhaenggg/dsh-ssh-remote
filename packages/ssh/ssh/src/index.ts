/**
 * SSH connection pool. Each workspace ssh://host/path routes to its own
 * connection, so multiple remote servers can be open simultaneously.
 * @module @zhaeng/dsh-ssh
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Client, type ConnectConfig } from 'ssh2'
import { readFileSync } from 'node:fs'

export { Client }
export type { ConnectConfig }

export { isSshPath, parseSshPath, buildSshPath, SSH_PATH_PREFIX } from './paths.ts'
export type { SshRemotePath } from './paths.ts'

export interface Config {
  host: string
  port?: number
  username: string
  privateKey?: string
  privateKeyPath?: string
  password?: string
  cwd?: string
  connectTimeoutMs?: number
}

interface ResolvedConfig {
  host: string
  port: number
  username: string
  privateKey: string | undefined
  privateKeyPath: string | undefined
  password: string | undefined
  cwd: string | undefined
  connectTimeoutMs: number
}

type HostKey = string

/** Settings namespace the SSH settings page writes; the pool hot-reloads from it. */
export const SSH_SETTINGS_NAMESPACE = settingsNamespace('ssh')

/** One settings-managed profile row (the GUI SSH page shape: password auth only). */
export interface SshSettingsProfile {
  name: string
  host: string
  port: number
  username: string
  password: string
}

/** The `ssh` settings section: the complete profile list. */
export interface SshSettingsSection {
  profiles: SshSettingsProfile[]
}

const SSH_SETTINGS_SCHEMA: z<SshSettingsSection> = z.object({
  profiles: z.array(z.object({
    name: z.string().default(''),
    host: z.string().default(''),
    port: z.number().default(22),
    username: z.string().default(''),
    password: z.string().default(''),
  })).default([]),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    ssh: SshRuntime
  }
}

/** Minimal connection-pool surface backends may hold without the full runtime. */
export interface SshPoolLike {
  getClient(hostKey?: string): Promise<Client>
  getCwd(hostKey?: string): string
}

export class SshRuntime extends Service {
  static Config: z<Config> = z.object({
    host: z.string(),
    port: z.number().default(22),
    username: z.string(),
    privateKey: z.string(),
    privateKeyPath: z.string(),
    password: z.string(),
    cwd: z.string().default('/home/user/workspace'),
    connectTimeoutMs: z.number().default(30_000),
  })

  private readonly envProfiles = new Map<HostKey, ResolvedConfig>()
  private readonly profiles = new Map<HostKey, ResolvedConfig>()
  private readonly clients = new Map<HostKey, Promise<Client>>()
  private readonly settled = new Map<HostKey, Client>()
  private disposed = false
  private settingsSection: () => SshSettingsSection = () => ({ profiles: [] })

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    this.ingestProfile(config)

    try {
      const raw = process.env.DSH_SSH_PROFILES
      if (raw !== undefined && raw.length > 0) {
        for (const p of JSON.parse(raw) as Config[]) this.ingestProfile(p)
      }
    } catch (error: unknown) {
      // A malformed DSH_SSH_PROFILES value keeps configured profiles; nothing else can reach this block.
      console.error('[dsh-ssh] ignoring malformed DSH_SSH_PROFILES: ' + String(error))
    }
    for (const [key, cfg] of this.profiles) this.envProfiles.set(key, cfg)

    // The GUI SSH settings page owns the user layer; every committed change
    // re-resolves the pool's profile map without a restart. Settings rows
    // override env rows with the same host:port.
    installSettingsSection(ctx, SSH_SETTINGS_NAMESPACE, SSH_SETTINGS_SCHEMA, { profiles: [] }, {
      setSource: (get) => { this.settingsSection = get },
      onChange: () => { this.applySettingsProfiles(this.settingsSection().profiles) },
    })

    ctx.effect(() => async () => {
      this.disposed = true
      const pending = Array.from(this.clients.values())
      for (const p of pending) {
        const c = await p.catch(() => undefined)
        if (c !== undefined) c.end()
      }
    }, 'ssh pool teardown')
  }

  async getClient(hostKey?: string): Promise<Client> {
    this.assertActive()

    const key = hostKey ?? this.firstKey()
    const settled = this.settled.get(key)
    if (settled !== undefined) return settled

    let pending = this.clients.get(key)
    if (pending === undefined) {
      const cfg = this.profiles.get(key)
      if (cfg === undefined) {
        const known = Array.from(this.profiles.keys()).join(', ')
        throw new Error(
          'dsh-ssh: no profile for ' + (hostKey ?? '(default)') +
          '. Known: ' + known,
        )
      }
      pending = this.connect(cfg)
      this.clients.set(key, pending)
      void pending.then((c) => { this.settled.set(key, c) }).catch(() => {})
    }
    const client = await pending
    this.assertActive()
    return client
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('SSH pool is disposing')
  }

  /** Return the configured remote cwd for a host. */
  getCwd(hostKey?: string): string {
    const key = hostKey ?? this.firstKey()
    const cfg = this.profiles.get(key)
    return cfg?.cwd ?? '/home/user/workspace'
  }

  /** Return the adapter state directory under the host cwd. */
  getRuntimeRoot(hostKey?: string): string {
    const cwd = this.getCwd(hostKey)
    return cwd.endsWith('/') ? cwd + '.dsh-ssh' : cwd + '/.dsh-ssh'
  }

  private firstKey(): string {
    for (const key of this.profiles.keys()) return key
    throw new Error('dsh-ssh: no profiles configured')
  }

  private hostKey(host: string, port: number): HostKey {
    return port === 22 ? host : host + ':' + String(port)
  }

  /** Rebuild the effective profile map: env base, settings rows on top. */
  private applySettingsProfiles(rows: readonly SshSettingsProfile[]): void {
    this.profiles.clear()
    for (const [key, cfg] of this.envProfiles) this.profiles.set(key, cfg)
    for (const row of rows) {
      if (typeof row.host !== 'string' || row.host.length === 0) continue
      this.profiles.set(this.hostKey(row.host, row.port || 22), {
        host: row.host,
        port: row.port || 22,
        username: row.username,
        privateKey: undefined,
        privateKeyPath: undefined,
        password: row.password || undefined,
        cwd: undefined,
        connectTimeoutMs: 30_000,
      })
    }
  }

  private ingestProfile(cfg: Config): void {
    // The web profile inserts this plugin without per-host config; hosts arrive
    // via DSH_SSH_PROFILES. An entry without a host contributes no profile.
    if (typeof cfg.host !== 'string' || cfg.host.length === 0) return
    const key = this.hostKey(cfg.host, cfg.port ?? 22)
    if (this.profiles.has(key)) return
    this.profiles.set(key, {
      host: cfg.host,
      port: cfg.port ?? 22,
      username: cfg.username,
      privateKey: cfg.privateKey,
      privateKeyPath: cfg.privateKeyPath,
      password: cfg.password,
      cwd: cfg.cwd ?? '/home/user/workspace',
      connectTimeoutMs: cfg.connectTimeoutMs ?? 30_000,
    })
  }

  private validate(cfg: ResolvedConfig): void {
    if (cfg.host.length === 0) throw new Error('dsh-ssh: configure host')
    if (cfg.username.length === 0) throw new Error('dsh-ssh: configure username')
    if (!cfg.privateKey && !cfg.privateKeyPath && !cfg.password) {
      throw new Error(
        'dsh-ssh: configure at least one of privateKey, privateKeyPath, or password',
      )
    }
    if (
      !Number.isFinite(cfg.connectTimeoutMs) ||
      cfg.connectTimeoutMs <= 0
    ) {
      throw new Error('dsh-ssh: connectTimeoutMs must be a positive finite number')
    }
  }

  private connect(cfg: ResolvedConfig): Promise<Client> {
    this.validate(cfg)
    const client = new Client()
    const cc: ConnectConfig = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      readyTimeout: cfg.connectTimeoutMs,
      keepaliveInterval: 30_000,
    }
    if (cfg.privateKey !== undefined) { (cc as Record<string, unknown>).privateKey = cfg.privateKey }
    if (cfg.privateKeyPath !== undefined && cfg.privateKeyPath.length > 0) {
      try { (cc as Record<string, unknown>).privateKey = readFileSync(cfg.privateKeyPath, 'utf-8') }
      catch { /* key file load failure is surfaced by ssh2 connect */ }
    }
    // password stays optional per ssh2 ConnectConfig
    if (cfg.password !== undefined) { cc.password = cfg.password }
    // Use the SSH agent when available (respects SSH_AUTH_SOCK).
    if (process.env.SSH_AUTH_SOCK !== undefined) { (cc as Record<string, unknown>).agent = process.env.SSH_AUTH_SOCK }

    return new Promise<Client>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.end()
        reject(new Error(
          'dsh-ssh: ' + cfg.host + ':' + String(cfg.port) +
          ' timed out after ' + String(cfg.connectTimeoutMs) + 'ms',
        ))
      }, cfg.connectTimeoutMs)

      client.on('ready', () => {
        clearTimeout(timer)
        resolve(client)
      })

      client.on('error', (err: Error) => {
        clearTimeout(timer)
        reject(new Error(
          'dsh-ssh: ' + cfg.host + ' connection failed: ' + err.message,
          { cause: err },
        ))
      })

      client.on('close', () => {
        clearTimeout(timer)
        const hk = this.hostKey(cfg.host, cfg.port)
        if (!this.settled.has(hk)) {
          reject(new Error('dsh-ssh: ' + cfg.host + ' closed before ready'))
        }
      })

      try {
        client.connect(cc)
      } catch (err: unknown) {
        clearTimeout(timer)
        reject(new Error(
          'dsh-ssh: ' + cfg.host + ' connect failed: ' +
          (err instanceof Error ? err.message : String(err)),
          { cause: err },
        ))
      }
    })
  }
}

export default SshRuntime
