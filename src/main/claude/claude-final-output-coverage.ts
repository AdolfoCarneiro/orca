import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import type { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import type { ClaudeStreamedThinking } from './claude-streamed-thinking'
import type { ClaudeSession } from './structured/claude-structured-session-state'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

/** A refused final snapshot makes this acquisition's leaf unsafe; the next open re-derives it. */
export function createClaudeFinalOutputCoverage(target: StructuredAgentSessionEventSink) {
  let admitted = true
  const record = (result: StructuredAgentSessionSinkAdmission) => {
    admitted &&= result.accepted
    return result
  }
  const append: NonNullable<StructuredAgentSessionEventSink['tryAppendItem']> = (
    identity,
    body,
    options
  ) => {
    const result = target.tryAppendItem?.(identity, body, options)
    if (result === undefined) {
      target.appendItem(identity, body, options)
    }
    const admission = result ?? { accepted: true }
    return options.lifecycle ? record(admission) : admission
  }
  const revise = target.tryReviseResolvedItem
  const reviseAndPublish = target.tryReviseResolvedItemAndPublish
  const transitionAppend = target.tryAppendTransition
  const sink: StructuredAgentSessionEventSink = {
    ...target,
    ...(transitionAppend
      ? {
          tryAppendTransition: (transition) => {
            const admission = transitionAppend(transition)
            return transition.lifecycle || transition.finalTail ? record(admission) : admission
          }
        }
      : {}),
    appendItem: (identity, body, options) => {
      if (options.lifecycle) {
        append(identity, body, options)
      } else {
        target.appendItem(identity, body, options)
      }
    },
    tryAppendItem: append,
    ...(revise
      ? {
          tryReviseResolvedItem: (...args: Parameters<typeof revise>) => {
            const admission = revise(...args)
            return args[2].lifecycle ? record(admission) : admission
          }
        }
      : {}),
    ...(reviseAndPublish
      ? {
          tryReviseResolvedItemAndPublish: (...args: Parameters<typeof reviseAndPublish>) => {
            const admission = reviseAndPublish(...args)
            return args[2].lifecycle ? record(admission) : admission
          }
        }
      : {})
  }
  return {
    sink,
    get admitted() {
      return admitted
    }
  }
}

/** Reader delivery, final handoff and persistence share one idempotent retirement. */
export function createClaudeOutputRetirement(input: {
  finish: () => void
  written: () => ReturnType<NonNullable<StructuredAgentSessionEventSink['written']>> | undefined
  dispose: () => void
}) {
  let retirement: Promise<void> | undefined
  return (delivered: Promise<void>): Promise<void> =>
    (retirement ??= (async () => {
      try {
        await delivered
        input.finish()
        const written = await input.written()
        if (written && !written.ok) {
          throw written.error
        }
      } finally {
        input.dispose()
      }
    })())
}

/** Keep delivered output on the old writer until handoff and written settlement, even after root proof. */
export async function retireClaudeSessionOutput(session: ClaudeSession): Promise<void> {
  if (session.translator?.retireOutput) {
    await session.translator.retireOutput(session.connection.outputDrained ?? Promise.resolve())
  } else {
    session.translator?.dispose()
  }
  session.unbindReadingControl?.()
}

export function claudeCheckpointOutputRetirement(
  sink: StructuredAgentSessionEventSink,
  text: ReturnType<typeof createClaudeStreamedTextCheckpoints>,
  thinking: ClaudeStreamedThinking,
  endedAt: () => number | undefined,
  dispose: () => void
) {
  return createClaudeOutputRetirement({
    finish: () => {
      text.finish({ completedAt: endedAt() }, { finalTail: true })
      thinking.finishOpen(endedAt() ?? Date.now(), { finalTail: true })
      if (!text.finalize() || !thinking.finalizeOutput()) {
        throw new Error('Claude output handoff failed')
      }
    },
    written: () => sink.written?.(),
    dispose
  })
}
/** Root exit releases the lease even with unverified descendants; a failed spawn proves no exit. */
export function claudeRootExitObserved(
  connection: ClaudeStreamJsonConnection | null | undefined
): boolean {
  const verdict = connection?.exitVerdict
  return verdict?.root === 'exited' && verdict.processless !== true
}
