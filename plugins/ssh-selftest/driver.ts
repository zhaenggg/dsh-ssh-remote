/**
 * One-shot selftest driver: creates the Agent at the ssh:// cwd from
 * DSH_SELFTEST_CWD, runs DSH_SELFTEST_TASK to quiescence, prints every tool
 * event outcome, and exits non-zero when a tool call errored.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'

export const name = 'ssh-selftest-driver'

export const inject = ['agents', 'agentDefaultModel', 'sessions']

function brief(event: SessionEvent): string {
  return JSON.stringify(event).slice(0, 600)
}

export function apply(ctx: Context): void {
  const cwd = process.env.DSH_SELFTEST_CWD
  const task = process.env.DSH_SELFTEST_TASK
  if (cwd === undefined || cwd === '' || task === undefined || task === '') {
    throw new Error('ssh-selftest-driver: DSH_SELFTEST_CWD and DSH_SELFTEST_TASK are required')
  }
  void (async () => {
    await ctx.get('loader')?.await()
    const agents = ctx.get('agents')
    const defaultModel = ctx.get('agentDefaultModel')
    const sessions = ctx.get('sessions')
    if (agents === undefined || defaultModel === undefined || sessions === undefined) {
      throw new Error('ssh-selftest-driver: core services missing')
    }
    const selection = defaultModel.currentSelection()
    const { agent } = await agents.create({
      sessionId: SessionId(`selftest-${randomUUID()}`),
      meta: { cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        const selected: ModelSelectionRef = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
      },
    })
    await agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: task }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await sessions.flush(agent.session)
    let failures = 0
    const lines: string[] = []
    for (const event of agent.session.events) {
      if (event.type.includes('tool')) {
        lines.push(`[${event.type}] ${brief(event)}`)
        if (JSON.stringify(event).includes('"is_error":true')) failures += 1
      }
      if (event.type === 'turn/end') {
        lines.push(`[turn/end] ${JSON.stringify((event.data as Record<string, unknown>).reason)}`)
      }
    }
    console.log(lines.join('\n'))
    process.exit(failures > 0 ? 2 : 0)
  })().catch((error: unknown) => {
    console.error('selftest failed:', error)
    process.exit(1)
  })
}
