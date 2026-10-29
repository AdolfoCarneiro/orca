import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalMessageItem
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionItemAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  AGENT_SESSION_DELTA_COALESCE_MS,
  AGENT_SESSION_TEXT_CHECKPOINT_MS
} from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import { claudeCheckpointStep } from './claude-checkpoint-intent'
import {
  consumeClaudeCheckpointFrame,
  claudeCheckpointAppendOptions,
  type HeldClaudeCheckpointFrame,
  type ClaudeCheckpointRoute,
  type ClaudeCheckpointTransfer,
  type PendingClaudeCheckpoint,
  type ClaudeStreamedBlockEnd,
  type ClaudeStreamedTextCheckpointDeps
} from './claude-checkpoint-input'
/** Only unadmitted input is budget.bytes; clean routes contain scalars, never full text. */
export function createClaudeStreamedTextCheckpoints(deps: ClaudeStreamedTextCheckpointDeps) {
  const routes = new Map<string, ClaudeCheckpointRoute>()
  const dirty = new Map<string, PendingClaudeCheckpoint>()
  const budget = deps.deliveryBudget ?? { bytes: 0, transfer: () => transfer(dirty.keys()) }
  let cancel: (() => void) | undefined
  let timerAt = Infinity
  let failed = false
  let held: HeldClaudeCheckpointFrame | undefined
  const window = deps.coalesceMs ?? AGENT_SESSION_DELTA_COALESCE_MS
  const schedule =
    deps.schedule ??
    ((run, ms) => {
      const timer = setTimeout(run, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  const optionsFor = (route: ClaudeCheckpointRoute) =>
    claudeCheckpointAppendOptions(route, deps.producer)
  const owe = (key: string, route: ClaudeCheckpointRoute): PendingClaudeCheckpoint => {
    let debt = dirty.get(key)
    if (!debt) {
      debt = {
        chunks: [],
        bytes: 0,
        due:
          route.lastAccepted === undefined
            ? performance.now() + window
            : Math.max(performance.now(), route.lastAccepted + AGENT_SESSION_TEXT_CHECKPOINT_MS)
      }
      dirty.set(key, debt)
    }
    return debt
  }
  const arm = (at: number) => {
    if (failed || at >= timerAt) {
      return
    }
    cancel?.()
    timerAt = at
    cancel = schedule(
      () => {
        cancel = undefined
        timerAt = Infinity
        const now = performance.now()
        for (const [key, debt] of dirty) {
          if (debt.due <= now) {
            transfer([key])
          }
        }
        resumeHeld()
        rearm()
      },
      Math.max(0, at - performance.now())
    )
  }
  const rearm = () => {
    cancel?.()
    cancel = undefined
    timerAt = Infinity
    for (const debt of dirty.values()) {
      arm(debt.due)
    }
  }
  const transfer = (keys: Iterable<string>, finalTail = false): boolean => {
    const intents: ClaudeCheckpointTransfer[] = []
    for (const key of keys) {
      const debt = dirty.get(key),
        route = routes.get(key)
      if (debt && route) {
        intents.push({
          key,
          route,
          debt,
          intent: {
            identity: route.identity,
            role: deps.role,
            suffix: debt.chunks,
            replacement: debt.replacement,
            ended: route.ended,
            options: optionsFor(route)
          }
        })
      }
    }
    if (!intents.length) {
      return !failed
    }
    const steps = intents.map(({ intent }) => claudeCheckpointStep(intent))
    // Journal resolution may run synchronously and release pressure reentrantly.
    for (const { key, debt } of intents) {
      dirty.delete(key)
      budget.bytes -= debt.bytes
    }
    const result = deps.sink.tryAppendTransition?.({
      steps,
      lifecycle: intents.some(({ route }) => route.ended !== undefined),
      finalTail: finalTail ? true : undefined,
      publish: true
    })
    if (!result) {
      // Isolated transcript projection/legacy test sinks only submit supplied full bodies.
      for (const { intent } of intents) {
        if (!intent.replacement && !intent.suffix.length) {
          continue
        }
        if (!intent.replacement) {
          throw new Error('Claude incremental checkpoints require an ordered journal sink')
        }
        deps.sink.appendItem(intent.identity, intent.replacement, intent.options)
      }
      deps.sink.publish()
    } else if (!result.accepted) {
      failed = result.reason !== 'backpressure'
      for (const { key, debt } of intents) {
        dirty.set(key, debt)
        budget.bytes += debt.bytes
        debt.due = performance.now() + window
      }
      return false
    }
    for (const { key, route, intent } of intents) {
      route.lastAccepted = performance.now()
      route.acceptedOptionsFingerprint = JSON.stringify(intent.options)
      if (route.parent !== null && deps.producer.linkageFor(route.parent).kind === 'linked') {
        route.options = intent.options
      }
      if (route.retired && !dirty.has(key)) {
        routes.delete(key)
      }
    }
    return true
  }
  const consume = (frame: HeldClaudeCheckpointFrame) =>
    consumeClaudeCheckpointFrame(frame, { dirty, budget, owe, arm })
  const resumeHeld = () => {
    const frame = held
    if (!frame) {
      return
    }
    held = undefined
    if (failed || consume(frame)) {
      frame.resolve()
    } else {
      held = frame
    }
  }
  const flush = (keys: Iterable<string> = dirty.keys(), finalTail = false) => {
    const accepted = transfer(keys, finalTail)
    resumeHeld()
    rearm()
    return accepted && !held
  }
  const routeFor = (
    identity: AgentJournalItemIdentity,
    parent: string | null,
    options: StructuredAgentSessionItemAppendOptions
  ) => {
    const key = agentJournalItemKey(identity)
    let route = routes.get(key)
    if (!route) {
      route = { identity, parent, options, bytes: 0, truncated: false, retired: false }
      routes.set(key, route)
    }
    route.retired = false
    return { key, route }
  }
  let delivery: Promise<void> = Promise.resolve()
  return {
    append: (
      identity: AgentJournalItemIdentity,
      text: string,
      parent: string | null = null,
      options: StructuredAgentSessionItemAppendOptions = { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    ) => {
      if (held) {
        throw new Error('Claude output advanced before delivery drained')
      }
      const { key, route } = routeFor(identity, parent, options)
      delivery = new Promise<void>((resolve) => {
        const frame = { key, route, text, offset: 0, resolve }
        if (consume(frame)) {
          resolve()
        } else {
          held = frame
          arm(performance.now() + window)
        }
      })
    },
    replace: (
      identity: AgentJournalItemIdentity,
      body: AgentJournalMessageItem | undefined,
      parent: string | null,
      options: StructuredAgentSessionItemAppendOptions,
      ended?: ClaudeStreamedBlockEnd
    ) => {
      const { key, route } = routeFor(identity, parent, options)
      const debt = owe(key, route)
      if (body) {
        budget.bytes -= debt.bytes
        debt.chunks = []
        debt.bytes = 0
        debt.replacement = body
      }
      route.ended ??= ended
      route.bytes = 0
      route.truncated = false
      flush([key])
    },
    flush,
    admit: () => transfer(dirty.keys()),
    transfer: (keys: Iterable<string>) => flush(keys),
    reattribute: () => {
      for (const [key, route] of routes) {
        const accepted = route.acceptedOptionsFingerprint
        if (accepted && accepted !== JSON.stringify(optionsFor(route))) {
          owe(key, route)
        }
      }
      flush()
    },
    finish: (
      ended: ClaudeStreamedBlockEnd,
      options: { only?: (key: string) => boolean; finalTail?: boolean } = {}
    ) => {
      for (const [key, route] of routes) {
        if ((!options.only || options.only(key)) && !route.ended) {
          route.ended = ended
          route.bytes = 0
          route.truncated = false
          owe(key, route)
        }
      }
      flush(dirty.keys(), options.finalTail)
    },
    retire: (sessionId: string, parent: string | null, completedAt: number) => {
      for (const [key, route] of routes) {
        if (
          route.identity.provider === 'claude' &&
          route.identity.sessionId === sessionId &&
          route.parent === parent
        ) {
          route.retired = true
          if (!route.ended) {
            route.ended = { completedAt }
            owe(key, route)
          }
          if (!dirty.has(key)) {
            routes.delete(key)
          }
        }
      }
      flush()
    },
    finalize: () => flush(dirty.keys(), true),
    settle: () => {
      for (const [key, route] of routes) {
        route.retired = true
        if (!dirty.has(key)) {
          routes.delete(key)
        }
      }
    },
    whenDelivered: () => delivery,
    get pending() {
      return dirty.size + (held ? 1 : 0)
    },
    dispose: () => {
      cancel?.()
      cancel = undefined
      routes.clear()
      for (const debt of dirty.values()) {
        budget.bytes -= debt.bytes
      }
      dirty.clear()
      failed = true
      resumeHeld()
    }
  }
}
