import type { CreateOrAttachResult } from './types'
export type PendingPtySpawnPreparation = {
  canceled: boolean
  switchAnchor?: { token: string; invocationId: string; at: number; deadline: number }
  // Unlike the polled canceled flag, the signal interrupts in-flight cwd probes on dead shares.
  readonly controller: AbortController
  settlement?: {
    completion: Promise<void>
    finish: () => void
    notifyExit?: (result: CreateOrAttachResult, code: number) => void
    result?: CreateOrAttachResult
    noChild: boolean
    failed?: true
    preparationWork?: Promise<void>
    physicalCompletion?: Promise<void>
    reconcile?: () => Promise<void>
    producerFinished?: boolean
  }
  cancelTimer?: ReturnType<typeof setTimeout>
  // Session IDs can be shared; disconnect cancels only this client's preparations.
  clientId: string
  requestId: string
}

export type CompletedPreparation = {
  outcome: 'exited' | 'failed'
  clientId: string
  requestId: string
  anchor: string
  invocationId: string
  incarnationId?: string
}
