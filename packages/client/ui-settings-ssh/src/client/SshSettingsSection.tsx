/**
 * SSH remote server profiles — multi-server configuration.
 * Each profile creates a workspace accessible from the sidebar.
 */
import { useCallback, useEffect, useState, type FC } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'

interface SshProfile {
  name: string
  host: string
  port: number
  username: string
  password: string
}

function defaultProfile(): SshProfile {
  return {
    name: '',
    host: '',
    port: 22,
    username: '',
    password: '',
  }
}

/** One persisted settings row. */
interface SshProfileRow {
  name: string
  host: string
  port: number
  username: string
  password: string
}

function toRow(p: SshProfile): SshProfileRow {
  return {
    name: p.name,
    host: p.host,
    port: p.port,
    username: p.username,
    password: p.password,
  }
}

function fromRow(row: SshProfileRow): SshProfile {
  return { ...defaultProfile(), ...row }
}

// styles
const S = {
  page: { padding: '24px 32px', maxWidth: '640px' } as React.CSSProperties,
  h1: { fontSize: '20px', fontWeight: 600, margin: '0 0 8px', color: 'var(--dsw-alias-label-primary)' } as React.CSSProperties,
  desc: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5, margin: '0 0 24px' } as React.CSSProperties,
  card: { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '8px', padding: '16px', marginBottom: '12px', background: 'var(--dsw-alias-bg-layer-1)' } as React.CSSProperties,
  cardHdr: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } as React.CSSProperties,
  cardTitle: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } as React.CSSProperties,
  row: { display: 'flex', gap: '12px', marginBottom: '12px' } as React.CSSProperties,
  field: { flex: 1, minWidth: 0 },
  lbl: { display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' } as React.CSSProperties,
  inp: { width: '100%', padding: '7px 10px', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '5px', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', boxSizing: 'border-box' as const, outline: 'none' } as React.CSSProperties,
  addBtn: { padding: '8px 16px', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '5px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', cursor: 'pointer', fontWeight: 500 } as React.CSSProperties,
  saveBtn: { padding: '8px 16px', background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-primary-foreground)', border: '1px solid var(--dsw-alias-brand-primary)', borderRadius: '5px', fontSize: '13px', cursor: 'pointer', fontWeight: 500 } as React.CSSProperties,
  delBtn: { padding: '6px 12px', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '4px', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', cursor: 'pointer' } as React.CSSProperties,
  note: { padding: '12px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '6px', fontSize: '12px', lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', marginTop: '20px', border: '1px solid var(--dsw-alias-border-l3)' } as React.CSSProperties,
}

// Profile card component
const ProfileCard: FC<{
  profile: SshProfile
  index: number
  update: (i: number, p: SshProfile) => void
  remove: (i: number) => void
}> = function ProfileCardFC({ profile, index, update, remove }) {
  const set = useCallback(<K extends keyof SshProfile>(key: K, value: SshProfile[K]) => {
    update(index, { ...profile, [key]: value })
  }, [index, profile, update])

  return (
    <div style={S.card}>
      <div style={S.cardHdr}>
        <input style={{ ...S.inp, width: 'auto', flex: 1 }}
          placeholder="配置名称，如：我的服务器"
          value={profile.name}
          onChange={(e) => { set('name', e.target.value) }} />
        <button style={S.delBtn} onClick={() => { remove(index) }}>删除</button>
      </div>

      <div style={S.row}>
        <div style={{ ...S.field, flex: 3 }}>
          <div style={S.lbl}>主机地址</div>
          <input style={S.inp} placeholder="192.168.1.100 或 myserver.com"
            value={profile.host} onChange={(e) => { set('host', e.target.value) }} />
        </div>
        <div style={{ ...S.field, flex: 1 }}>
          <div style={S.lbl}>端口</div>
          <input style={S.inp} type="number"
            value={profile.port} onChange={(e) => { set('port', Number(e.target.value) || 22) }} />
        </div>
      </div>

      <div style={S.row}>
        <div style={{ ...S.field, flex: 2 }}>
          <div style={S.lbl}>用户名</div>
          <input style={S.inp} placeholder="root"
            value={profile.username} onChange={(e) => { set('username', e.target.value) }} />
        </div>
        <div style={{ ...S.field, flex: 3 }}>
          <div style={S.lbl}>密码</div>
          <input style={S.inp} type="password" placeholder="输入 SSH 密码"
            value={profile.password} onChange={(e) => { set('password', e.target.value) }} />
        </div>
      </div>
    </div>
  )
}

// Main section
type Props = SettingsSectionOwnerProps & {
  api?: Pick<IApiClient, 'settings'>
}

export const SshSettingsSection: FC<Props> = function SshSettingsSectionFC(props) {
  const settingsApi = props.api?.settings
  const [profiles, setProfiles] = useState<SshProfile[]>([])
  const [saved, setSaved] = useState(false)
  const [loadError, setLoadError] = useState('')

  // Load the persisted section once; without the settings face (or a failed
  // call) the page starts empty and reports the failure instead of guessing.
  useEffect(() => {
    if (settingsApi === undefined) return
    let cancelled = false
    void settingsApi.describe({}).then((response) => {
      if (cancelled) return
      if (!response.result.ok) {
        setLoadError(response.result.error.message)
        return
      }
      const view = response.result.value.namespaces.find(ns => ns.ns === 'ssh')
      const rows = (view?.value as { profiles?: SshProfileRow[] } | undefined)?.profiles ?? []
      setProfiles(rows.map(fromRow))
    }, (error: unknown) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => { cancelled = true }
  }, [settingsApi])

  const addProfile = useCallback(() => {
    setProfiles(prev => [...prev, defaultProfile()])
    setSaved(false)
  }, [])

  const updateProfile = useCallback((i: number, p: SshProfile) => {
    setProfiles(prev => prev.map((item, idx) => idx === i ? p : item))
    setSaved(false)
  }, [])

  const removeProfile = useCallback((i: number) => {
    setProfiles(prev => prev.filter((_unused, idx) => idx !== i))
    setSaved(false)
  }, [])

  const save = useCallback(async () => {
    if (settingsApi !== undefined) {
      const response = await settingsApi.replace({ ns: 'ssh', section: { profiles: profiles.map(toRow) } })
      if (!response.result.ok) {
        setLoadError(response.result.error.message)
        return
      }
    }
    setSaved(true)
    setLoadError('')
  }, [profiles, settingsApi])

  return (
    <div style={S.page}>
      <h2 style={S.h1}>SSH 远程服务器</h2>
      <p style={S.desc}>
        配置远程服务器（地址、端口、用户名、密码）。在「添加工作区」的目录选择器中即可选择这些服务器并打开其上的目录作为远程工作区。
      </p>

      {profiles.map((p, i) =>
        <ProfileCard key={i} profile={p} index={i} update={updateProfile} remove={removeProfile} />,
      )}

      {loadError.length > 0 &&
        <div style={{ ...S.note, color: '#d54941' }}>读写设置失败：{loadError}</div>
      }

      <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
        <button style={S.addBtn} onClick={addProfile}>+ 添加服务器</button>
        {profiles.length > 0 &&
          <button style={S.saveBtn} onClick={() => { void save() }}>{saved ? '已保存' : '保存配置'}</button>
        }
      </div>

      <div style={S.note}>
        <strong>使用说明</strong><br />
        1. 配置保存在服务端（DSH 设置文件），保存后立即生效，无需重启<br />
        2. 每个服务器配置保存后会自动创建对应工作区<br />
        3. 私钥路径填 DSH 服务所在机器上的私钥文件路径；远程工作目录需已在服务器上存在<br />
        4. 也可通过环境变量 DSH_SSH_PROFILES 提供基础配置（同名主机以本页配置优先）
      </div>
    </div>
  )
}
