import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from './structured-agent-session-logger'
import type { StructuredAgentSessionConversationNaming } from './structured-agent-session-host-types'

/** Carries the user's chat name into the agent's own conversation, one push at a time per chat.
 *  A push reads the record when it runs, so a burst of renames lands as the latest name, and a
 *  name Orca chose is never pushed: the agents count a host rename as the user's. */
export function createStructuredAgentSessionProviderNaming(deps: {
  store: Pick<AgentSessionRecordStore, 'getRecord'>
  adapter: Pick<StructuredAgentSessionAdapter, 'renameProviderSession'>
  logger: StructuredAgentSessionLogger
}) {
  const logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
  // A chat's running push; `again` asks it to read the record once more when it finishes.
  const running = new Map<string, { again: boolean; done: Promise<void> }>()
  let stopped = false

  const pushOnce = async (sessionId: string): Promise<void> => {
    const record = deps.store.getRecord(sessionId)
    const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
    if (!record || record.conversationNameSource !== 'user' || !record.conversationName || !head) {
      return
    }
    await deps.adapter.renameProviderSession?.({
      record,
      providerSessionId: head.handle.nativeId,
      name: record.conversationName
    })
  }

  const drain = async (sessionId: string, entry: { again: boolean }): Promise<void> => {
    try {
      do {
        entry.again = false
        try {
          await pushOnce(sessionId)
        } catch (error) {
          logger.warn('naming the agent conversation after a chat rename failed', {
            scope: 'provider-session-rename',
            sessionId,
            error
          })
        }
      } while (entry.again)
    } finally {
      running.delete(sessionId)
    }
  }

  return {
    /** Never throws and never delays the caller; the promise is for tests and teardown. */
    push(sessionId: string): Promise<void> {
      if (stopped) {
        return Promise.resolve()
      }
      const current = running.get(sessionId)
      if (current) {
        current.again = true
        return current.done
      }
      const entry = { again: false, done: Promise.resolve() }
      running.set(sessionId, entry)
      entry.done = drain(sessionId, entry)
      return entry.done
    },
    /** Close admission synchronously; accepted updates finish before their adapters close. */
    async stop(): Promise<void> {
      stopped = true
      await Promise.all([...running.values()].map((entry) => entry.done))
    }
  }
}

/** The user's rename is saved and published first; the agent's own conversation follows. */
export function withProviderNaming(
  naming: StructuredAgentSessionConversationNaming,
  nameProvider: (sessionId: string) => void
): StructuredAgentSessionConversationNaming {
  return {
    ...naming,
    setUserName: async (sessionId, name, write) => {
      const result = await naming.setUserName(sessionId, name, write)
      if (result?.applied) {
        nameProvider(sessionId)
      }
      return result
    }
  }
}
