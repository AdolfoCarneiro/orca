import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../../shared/structured-agent-session-reducer'
import { MOBILE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../../mobile/src/transport/mobile-runtime-client-capabilities'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import {
  AgentSessionSubscribers,
  type AgentSessionSubscribeInput
} from '../../../native-chat/agent-session-wire/structured-agent-session-subscribers'
import {
  textRig,
  textBody,
  textIdentity,
  textOptions,
  closeTextJournals
} from '../../../native-chat/agent-session-journal/journal-text-test-support'
import {
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  openStream,
  SESSION,
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(installStructuredHostStub)
afterEach(async () => {
  clearStructuredHostStub()
  await closeTextJournals()
})

it.each([
  ['local', undefined, false, true],
  [
    'current desktop',
    {
      clientKind: 'runtime' as const,
      clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
    },
    false,
    true
  ],
  [
    'current phone',
    { clientKind: 'mobile' as const, clientCapabilities: MOBILE_RUNTIME_CLIENT_CAPABILITIES },
    false,
    true
  ],
  ['old desktop', STRUCTURED_CLIENT, false, false],
  ['old phone', STRUCTURED_MOBILE_CLIENT, false, false],
  [
    'current desktop on old host',
    {
      clientKind: 'runtime' as const,
      clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
    },
    true,
    false
  ],
  [
    'current phone on old host',
    { clientKind: 'mobile' as const, clientCapabilities: MOBILE_RUNTIME_CLIENT_CAPABILITIES },
    true,
    false
  ]
] as const)(
  'negotiates real subscriber delivery for %s',
  async (_name, client, oldHost, patches) => {
    const r = await textRig()
    const subscribers = new AgentSessionSubscribers()
    hostCalls.subscribe.mockImplementation((input: AgentSessionSubscribeInput) =>
      subscribers.open({
        ...input,
        ...(oldHost ? { textPatches: false } : {}),
        journal: r.journal,
        fence: 7
      })
    )
    const replies = await openStream('agentSession.subscribe', { sessionId: SESSION }, client)
    for (let index = 0; index < 5; index++) {
      await r.journal.appendItem(textIdentity, textBody(''), {
        ...textOptions,
        streamText: {
          operation: index === 0 ? 'start' : 'append',
          field: 0,
          baseLength: index * 2,
          suffix: '😀'
        }
      })
      subscribers.publish(SESSION, r.journal)
    }
    await r.journal.appendItem(textIdentity, textBody('😀'.repeat(5)), textOptions)
    subscribers.publish(SESSION, r.journal)
    let state = EMPTY_STRUCTURED_AGENT_SESSION
    let patchCount = 0
    for (const reply of replies) {
      const decoded: { ok: boolean; result: AgentSessionSubscribeEvent } = JSON.parse(
        JSON.stringify(reply)
      )
      expect(decoded.ok).toBe(true)
      if (decoded.result.type === 'batch' && decoded.result.batch.textPatches) {
        patchCount++
      }
      state = reduceStructuredAgentSession(state, { type: 'event', event: decoded.result })
    }
    expect(patchCount).toBe(patches ? 4 : 0)
    expect(state.items[0]?.body).toEqual(textBody('😀'.repeat(5)))
    expect(state.cursor).toEqual(r.journal.cursor())
  }
)
