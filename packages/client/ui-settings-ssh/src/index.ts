/**
 * SSH settings page host half: registers the settings.section slot.
 * @module @deepseek-ai/dsh-client-ui-settings-ssh
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'ui-settings-ssh'

export function apply(_ctx: Context): void {
  // No host-side registration needed; the client half owns the settings page.
}
