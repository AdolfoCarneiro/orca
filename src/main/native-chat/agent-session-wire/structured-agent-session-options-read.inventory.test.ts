import { expect, it } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-adapter'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  hostTestOptionsReadStore,
  hostTestRestingOptionsJournal,
  hostTestRestingOptionsRecord
} from './structured-agent-session-host-test-data'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { readStructuredAgentSessionOptions } from './structured-agent-session-options-read'

it('marks unknown resting inventory but preserves completed empty live and resting answers', async () => {
  const record = { ...hostTestRestingOptionsRecord(), provider: 'pi', options: {} }
  let inventory: AgentSessionModelCatalogResult = { origin: 'unknown' }
  let live: StructuredAgentSessionLiveOptions | undefined
  const session = () => ({
    child: live ? { fence: 1 } : null,
    params: { provider: record.provider },
    journal: hostTestRestingOptionsJournal()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
  const context = {
    deps: {
      adapter: { readOptions: async () => live },
      agents: NO_STRUCTURED_AGENTS,
      store: hostTestOptionsReadStore(() => record),
      modelCatalog: { read: async () => inventory }
    },
    serialize: (_id: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => session(),
    conversation: async () => session()
  } as unknown as StructuredAgentSessionMutationContext
  const read = () =>
    readStructuredAgentSessionOptions(context, record.sessionId, { readsWithoutModel: true })
  const unknown = await read()
  expect(unknown).toMatchObject({ models: [], modelsKnown: false, current: { defaulted: [] } })
  expect(unknown.current.model).toBeUndefined()
  inventory = { origin: 'probe', models: [], fetchedAt: 1 }
  const empty = await read()
  expect(empty.models).toEqual([])
  expect(empty).not.toHaveProperty('modelsKnown')
  inventory = { origin: 'unknown' }
  live = { models: [], current: {} }
  const completed = await read()
  expect(completed.models).toEqual([])
  expect(completed).not.toHaveProperty('modelsKnown')
  live = { models: [], modelsKnown: false, current: {} }
  expect((await read()).modelsKnown).toBe(false)
})
