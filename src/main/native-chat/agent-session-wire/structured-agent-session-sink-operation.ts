import type { StructuredAgentSessionExitObservation } from './structured-agent-session-exit-observation'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkState
} from './structured-agent-session-event-sink'
import type {
  StructuredAgentSessionEventTarget,
  StructuredAgentSessionSinkBarrier
} from './structured-agent-session-event-sink'
export type StructuredAgentSessionSinkOperation = {
  sequence: number
  bytes: number
  lifecycleBytes?: number
  lifecycle?: boolean
  finalTail?: true
  /** Only publications coalesce by key; replacing journal writes would reorder them behind later work. */
  publicationKey?: string
  /** Handover synchronously joins the journal queue in submission order. */
  run: (target: StructuredAgentSessionEventTarget) => Promise<unknown> | void
}

export type Admitted = StructuredAgentSessionSinkOperation & {
  superseded?: boolean
  releaseFinalTail?: () => void
}

export type StructuredAgentSessionDrainWaiter = {
  through: number
  resolve: (result: StructuredAgentSessionSinkBarrier) => void
}
export type DeferredStructuredAgentSessionEventSink = {
  sink: StructuredAgentSessionEventSink
  exitObservation(): Pick<StructuredAgentSessionExitObservation, 'heldSends' | 'observedAt'>
  bind(target: StructuredAgentSessionEventTarget): void
  unbind(): void
  close(): void
  drained(): Promise<StructuredAgentSessionSinkBarrier>
  lifecycleBarrier(): Promise<StructuredAgentSessionSinkBarrier>
  outputDrained?(): Promise<StructuredAgentSessionSinkBarrier>
  state(): StructuredAgentSessionSinkState
}
