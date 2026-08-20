import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-settings-ssh'
export const name = 'ui-settings-ssh-invariant'
export const inject = ['invariants']

/**
 * No runtime invariant: a browser-side settings form over the settings API.
 * The persisted ssh section it writes is owned and re-checked by dsh-ssh's
 * pool; this package holds no host-side state or events.
 */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
