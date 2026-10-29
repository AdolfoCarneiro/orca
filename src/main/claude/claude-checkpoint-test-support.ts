import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionSinkWatermarks
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'

/** Synchronous canonical view for existing translator unit recorders; recovery tests use the real journal. */
export function withCheckpointTestTransitions(
  sink: StructuredAgentSessionEventSink
): StructuredAgentSessionEventSink {
  const saved = new Map<
    string,
    { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }
  >()
  const append = sink.appendItem.bind(sink)
  sink.appendItem = (identity, body, options) => {
    append(identity, body, options)
    saved.set(agentJournalItemKey(identity), { identity, body })
  }
  const view = {
    epoch: 'test',
    canonicalItemId: (key: string) => key,
    item: (key: string) => {
      const item = saved.get(key)
      return item ? { itemId: key, revision: 1, sequence: 0, observedAt: 0, body: item.body } : null
    },
    itemBody: (key: string) => saved.get(key)?.body ?? null,
    visitItems: () => {},
    visitItemsWithLinkage: () => {}
  }
  const journal: StructuredAgentSessionTransitionJournal = view
  sink.tryAppendTransition = (transition) => {
    for (const step of transition.steps) {
      if (step.kind === 'settlement') {
        throw new Error('unexpected test settlement')
      }
      const resolved =
        step.kind === 'item' ? step.resolve(journal) : step.resolve(journal)?.compose()
      if (!resolved) {
        continue
      }
      const result = sink.tryAppendItem?.(resolved.identity, resolved.body, step.options)
      if (result && !result.accepted) {
        return result
      }
      if (!result) {
        sink.appendItem(resolved.identity, resolved.body, step.options)
      }
    }
    if (transition.publish) {
      sink.publish()
    }
    return { accepted: true }
  }
  return sink
}

const journals = createTrackedJournalOpener()
const roots: string[] = []
export async function closeCheckpointTestJournals() {
  vi.useRealTimers()
  await journals.closeAll()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}

export async function checkpointJournalRig(
  options: { watermarks?: Partial<StructuredAgentSessionSinkWatermarks>; unbound?: boolean } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-pr35462-checkpoint-'))
  roots.push(root)
  const journal = await journals.open({
    stateDirectory: root,
    identity: {
      sessionId: 'recovery',
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'claude',
      providerHandle: null
    }
  })
  const deferred = createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging('recovery'),
    watermarks: options.watermarks
  })
  const publish = vi.fn()
  const bind = () => deferred.bind({ journal, fence: 1, publish })
  if (!options.unbound) {
    bind()
  }
  const translator = createClaudeJournalTranslator({ sink: deferred.sink })
  let serial = 0
  const message = (message: Record<string, unknown>) =>
    translator.handle({
      type: 'message',
      sessionId: 'recovery',
      observedAt: Date.now(),
      message: {
        session_id: 'claude-session',
        parent_tool_use_id: null,
        uuid: `frame-${serial++}`,
        ...message
      }
    })
  const stream = (event: Record<string, unknown>) => message({ type: 'stream_event', event })
  return {
    root,
    journal,
    deferred,
    translator,
    message,
    stream,
    bind,
    publish,
    reopen: () =>
      journals.open({
        stateDirectory: root,
        identity: {
          sessionId: 'recovery',
          workspaceId: 'workspace',
          hostId: 'local',
          agent: 'claude',
          providerHandle: null
        }
      })
  }
}
