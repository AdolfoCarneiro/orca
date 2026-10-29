import {
  createStructuredAgentSessionCatalogReads,
  structuredAgentSessionCatalogScopeOwned
} from './structured-agent-session-catalog-reads'
import type { createRestartReconciler } from './structured-agent-session-restart-reconcile'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import {
  createStructuredAgentSessionHostRestore,
  revealStructuredAgentSession
} from './structured-agent-session-reveal'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import * as providerSupport from './structured-agent-session-provider-support'
import type { OpenedStructuredAgentSessionConversation } from './structured-agent-session-conversation-open'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { restoreStructuredAgentSessionRead } from './structured-agent-session-read-restore'
import { structuredAgentSessionReceivingAccount } from './structured-agent-session-receiving-account'

type ReadContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(id: string, task: () => Promise<T>) => Promise<T>
  restore: ReturnType<typeof createStructuredAgentSessionHostRestore>
  readCommands: StructuredAgentSessionClientDelivery['readCommandsSettled']
  conversation: (id: string) => Promise<StructuredAgentSessionHostSession>
  adoptOpened: (id: string, opened: OpenedStructuredAgentSessionConversation) => Promise<void>
}

/** Readers share the conversation owner; inventory never founds a journal or prepares a provider. */
export function createStructuredAgentSessionConversationReads(context: () => ReadContext) {
  const sessionOwned = async (id: string, current: () => boolean = () => true) => {
    const { deps, sessions, adoptOpened } = context()
    const record = deps.store.requireWritableRecord(id)
    let session = sessions.get(id)
    if (!session) {
      const opened = await restoreStructuredAgentSessionRead(deps, id)
      if (opened) {
        if (current()) {
          await adoptOpened(id, opened)
          session = opened.session
        } else {
          await opened.session.journal.close()
        }
      }
    }
    return { record, session }
  }
  const prospectiveAccountHomeOwned = async (id: string) => {
    const { record, session } = await sessionOwned(id)
    return (await structuredAgentSessionReceivingAccount(context().deps, record, session)).home
  }
  const readModelCatalog = createStructuredAgentSessionCatalogReads(() => ({
    deps: context().deps,
    serialize: context().serialize,
    scopeOwned: async (params) => {
      const record = params.sessionId
        ? context().deps.store.getConversation(params.sessionId)
        : undefined
      if (
        record &&
        (record.provider !== params.agent ||
          !providerSupport.agentDrivesSession(context().deps.agents, record))
      ) {
        return null
      }
      if (!record) {
        return null
      }
      if (!context().deps.store.getRecord(record.sessionId)) {
        return structuredAgentSessionCatalogScopeOwned(context().deps, params, undefined)
      }
      const { session } = await sessionOwned(record.sessionId, params.operation?.current)
      if (params.operation?.current() === false) {
        return null
      }
      return structuredAgentSessionCatalogScopeOwned(context().deps, params, session)
    }
  }))
  return {
    readModelCatalog,
    createRestore: (
      reconcileLeases: ReturnType<typeof createRestartReconciler>,
      runtimeState: StructuredAgentSessionHostRuntimeState,
      tabs: { markUnopened: (id: string) => void }
    ) => {
      const { deps, sessions, serialize, adoptOpened } = context()
      return createStructuredAgentSessionHostRestore(deps, {
        reconcileLeases,
        reconcileRestartLeases: () => reconcileLeases(),
        resolveRecovery: (id) => runtimeState.resolveRecovery(id),
        serialize,
        hasSession: (id) => sessions.has(id),
        onReadable: adoptOpened,
        onUnopened: (id) => tabs.markUnopened(id)
      })
    },
    reconcileRestartLeases: () => context().restore.reconcileRestartLeases(),
    restoreReadableSessions: (ids?: readonly string[]) =>
      context().restore.restoreReadableSessions(ids),
    readCommands: async (id: string) => ({ commands: await context().readCommands(id) }),
    supportsCreate: (location: AgentSessionExecutionLocation, agent: string) =>
      providerSupport.adapterSupportsCreate(context().deps.adapter, location, agent),
    knownAgentIds: () => providerSupport.knownAgentIds(context().deps),
    agentDefinitions: () => context().deps.agents.definitions(),
    revealSession: (id: string) => {
      const { deps, conversation } = context()
      return revealStructuredAgentSession(deps, id, conversation)
    },
    journalSnapshot: async (id: string) => (await context().conversation(id)).journal.snapshot(),
    sessionAgent: (id: string) => context().deps.store.getConversation(id)?.provider ?? null,
    childAccountHome: (id: string) => context().sessions.get(id)?.child?.accountHome,
    holdsSessions: () => context().deps.store.holdsRecords(),
    onSessionsHeld: (listener: () => void) => context().deps.store.onFirstRecord(listener),
    prospectiveAccountHome: (id: string) => {
      return context().serialize(id, () => prospectiveAccountHomeOwned(id))
    }
  }
}
