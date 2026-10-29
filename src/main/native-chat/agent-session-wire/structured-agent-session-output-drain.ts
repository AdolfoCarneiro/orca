import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'

/** Process proof does not retire a writer until delivered output has transferred and settled. */
export function structuredAgentSessionOutputDrain(
  written: () => Promise<StructuredAgentSessionSinkBarrier>
) {
  let outputDrain: (() => Promise<void>) | undefined
  return {
    bind: (drain: () => Promise<void>) => {
      outputDrain = drain
      return () => {
        if (outputDrain === drain) {
          outputDrain = undefined
        }
      }
    },
    written: async (): Promise<StructuredAgentSessionSinkBarrier> => {
      try {
        await outputDrain?.()
      } catch (error) {
        return { ok: false, error }
      }
      return written()
    }
  }
}
