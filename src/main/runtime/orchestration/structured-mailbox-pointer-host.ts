import { readMailCreationAuthority } from '../../native-chat/agent-session-journal/mail-creation-authority'
import { queuedMessagesPublishedBytes } from '../../native-chat/agent-session-wire/structured-agent-session-queued-published-bytes'
import {
  readMailCreationHistory,
  observeMailCreationHistory,
  forgetMailCreationHistorySource
} from './structured-mail-creation-history'
import {
  conversationRecordReader,
  resolveLineageRunningSession
} from './structured-session-lineage'
import { structuredSessionGateFacts } from './structured-session-pointer-delivery'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-delivery'
import { sendAgentTurn } from './send-agent-turn'

const MAIL_CALLER = 'trusted-local:orchestration:ordinary-mail'

/** One internal seam for ordinary command acceptance; no provider-consumption acknowledgement. */
export function createStructuredMailboxPointerHost(): StructuredMailboxPointerHost {
  const readCreation: StructuredMailboxPointerHost['readCreation'] = (
    operationId,
    _sessionId,
    legacy
  ) => {
    const host = getStructuredAgentSessionHost()
    if (!host) {
      return 'unknown'
    }
    const read = host.deps.store.readCommandReceipt({ kind: 'global' }, operationId)
    if (read.verdict === 'absent') {
      return 'absent'
    }
    if (read.verdict !== 'readable') {
      return 'unknown'
    }
    const receipt = read.receipt
    const target = resolveLineageRunningSession(
      conversationRecordReader(host.deps.store),
      receipt.sessionId
    )
    const validCaller = legacy
      ? receipt.callerKey.startsWith('trusted-local:orchestration:')
      : receipt.callerKey === MAIL_CALLER
    const created =
      receipt.status === 'accepted' &&
      ((receipt.result.kind === 'queued-draft' && receipt.result.messageId === operationId) ||
        (legacy && receipt.result.kind === 'journal-row'))
    return target.kind === 'here' &&
      validCaller &&
      receipt.method === 'agentSession.send' &&
      created
      ? 'accepted'
      : 'unknown'
  }
  return {
    readCreation,
    creationAuthority: () => {
      const host = getStructuredAgentSessionHost()
      return host ? readMailCreationAuthority(host.deps.journalDatabase.db) : null
    },
    observeHistory: (listener) => {
      const host = getStructuredAgentSessionHost()
      return host && observeMailCreationHistory(host, listener)
    },
    forgetHistorySource: (key) => {
      const host = getStructuredAgentSessionHost()
      if (host) {
        forgetMailCreationHistorySource(host, key)
      }
    },
    readHistory: (sessionId, key) => {
      const host = getStructuredAgentSessionHost()
      return host
        ? readMailCreationHistory(host, sessionId, key)
        : { members: new Set(), opaque: true }
    },
    admission: (sessionId) => {
      const host = getStructuredAgentSessionHost()
      const record = host?.deps.store.getRecord(sessionId)
      if (
        !host ||
        !record ||
        resolveLineageRunningSession(conversationRecordReader(host.deps.store), sessionId).kind !==
          'here'
      ) {
        return null
      }
      const journal = host.queuedMailJournal(sessionId)
      return {
        owner: host,
        generation: JSON.stringify([
          record.sessionId,
          record.location,
          record.lease.runtimeFence,
          journal?.epoch,
          readMailCreationAuthority(host.deps.journalDatabase.db)
        ]),
        queuedBytes: journal ? queuedMessagesPublishedBytes(journal) : 0
      }
    },
    currentFence: (sessionId) =>
      getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.currentFence ?? null,
    send: async (input) => {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return { kind: 'unattached' }
      }
      const prior = readCreation(input.operationId, input.sessionId)
      if (prior === 'accepted') {
        return { kind: 'queued' }
      }
      if (prior !== 'absent') {
        return { kind: 'held' }
      }
      const outcome = await sendAgentTurn({
        kind: 'structured-session',
        host,
        callerKey: MAIL_CALLER,
        sessionId: input.sessionId,
        turn: {
          body: input.body,
          operationId: input.operationId,
          expectedRuntimeFence: input.expectedRuntimeFence,
          delivery: 'queue',
          queueAlways: true,
          mailSource: input.mailSource,
          beforeRun: input.beforeRun
        }
      })
      if (outcome.kind === 'queued') {
        return { kind: 'queued' }
      }
      if (outcome.kind === 'refused') {
        if (outcome.refusal.details?.reason === 'queueTooLarge') {
          return { kind: 'capacity' }
        }
        if (
          outcome.refusal.code === 'agent_session_operation_unknown' ||
          outcome.refusal.code === 'execution_owner_reconciling'
        ) {
          return { kind: 'retry' }
        }
      }
      return { kind: 'held' }
    }
  }
}

export const structuredPointerCallerKey = (dispatchId: string): string =>
  `trusted-local:orchestration:${dispatchId}`
export const structuredSessionPointerCallerKey = (sessionId: string): string =>
  `trusted-local:orchestration:session:${sessionId}`

export async function readStructuredSessionGateFacts(sessionId: string) {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    const snapshot = await host.journalSnapshot(sessionId)
    return structuredSessionGateFacts(snapshot.items, host.currentWork(sessionId)?.scope)
  } catch {
    return null
  }
}
