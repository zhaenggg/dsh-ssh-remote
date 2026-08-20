/**
 * SSH settings page browser half: registers on settings.section.
 * @module @zhaenggg/dsh-client-ui-settings-ssh/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { SshSettingsSection } from './SshSettingsSection'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  let handle: ConnectionHandle | undefined
  try {
    // Optional service read: the connection face is absent while the transport
    // layer is not composed, and the section then renders without persistence.
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    handle = connection
  } catch {
    handle = undefined
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'ssh',
    order: 50,
    label: () => 'SSH 远程',
  }, props => SshSettingsSection({ ...props, ...handle !== undefined ? { api: handle.api } : {} })))
}
