import {
  compactDaemonSpawnPreparation,
  releaseDaemonSpawnPreparation
} from './daemon-pty-spawn-preparation-release'
import type {
  PendingPtySpawnPreparation,
  CompletedPreparation
} from './daemon-pty-spawn-preparation-state'
import {
  TerminalAttachCanceledError,
  type CreateOrAttachResult,
  type CreateOrAttachSettlement
} from './types'
export {
  type PendingPtySpawnPreparation,
  type CompletedPreparation
} from './daemon-pty-spawn-preparation-state'

export class DaemonPtySpawnPreparations {
  private readonly retained = new Map<string, PendingPtySpawnPreparation | CompletedPreparation>()

  hasOwedOutcomes(): boolean {
    return this.retained.size > 0
  }

  private readonly pending = new Map<string, Set<PendingPtySpawnPreparation>>()
  private readonly cancellationByPreparation = new WeakMap<
    PendingPtySpawnPreparation,
    { promise: Promise<void>; resolve: () => void }
  >()

  constructor(private readonly preparePtySpawn: () => Promise<void>) {}

  register(
    sessionId: string,
    clientId: string,
    requestId: string,
    cancelAfterMs: unknown
  ): PendingPtySpawnPreparation {
    const preparation: PendingPtySpawnPreparation = {
      canceled: false,
      controller: new AbortController(),
      clientId,
      requestId
    }
    let resolveCancellation!: () => void
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve
    })
    this.cancellationByPreparation.set(preparation, {
      promise: cancellation,
      resolve: resolveCancellation
    })
    if (Number.isSafeInteger(cancelAfterMs) && Number(cancelAfterMs) > 0) {
      preparation.cancelTimer = setTimeout(
        () => this.cancelPreparation(preparation),
        Math.min(Number(cancelAfterMs), 300_000)
      )
      preparation.cancelTimer.unref()
    }
    const pendingForSession = this.pending.get(sessionId) ?? new Set()
    pendingForSession.add(preparation)
    this.pending.set(sessionId, pendingForSession)
    return preparation
  }

  prepareSwitch(sessionId: string, clientId: string, requestId: string, invocationId: string) {
    const preparation = this.register(sessionId, clientId, requestId, undefined)
    const completion = Promise.withResolvers<void>()
    preparation.settlement = {
      completion: completion.promise,
      finish: completion.resolve,
      noChild: true
    }
    this.retained.set(JSON.stringify([sessionId, clientId, requestId]), preparation)
    preparation.switchAnchor = {
      token: requestId,
      invocationId,
      at: performance.now(),
      deadline: Infinity
    }
    preparation.cancelTimer = setTimeout(() => {
      this.cancelPreparation(preparation)
      this.finish(sessionId, preparation)
    }, 720_000)
    preparation.cancelTimer.unref?.()
    return { anchor: requestId, retention: 'creation-settlement-v1' as const }
  }

  commitSwitch(
    sessionId: string,
    clientId: string,
    requestId: string,
    execution: { invocationId: string; anchor?: string; remainingMs?: number; contract?: string }
  ): PendingPtySpawnPreparation {
    const preparation = [...(this.pending.get(sessionId) ?? [])].find(
      (entry) =>
        entry.clientId === clientId &&
        entry.switchAnchor?.token === execution.anchor &&
        entry.switchAnchor?.invocationId === execution.invocationId
    )
    const anchor = preparation?.switchAnchor
    if (!preparation || !anchor || anchor.deadline !== Infinity) {
      throw new TerminalAttachCanceledError(sessionId)
    }
    preparation.requestId = requestId
    if (
      execution.contract !== 'creation-settlement-v1' ||
      preparation.canceled ||
      !Number.isFinite(execution.remainingMs) ||
      execution.remainingMs! <= 0 ||
      execution.remainingMs! > 720_000
    ) {
      this.cancelPreparation(preparation)
      this.finish(sessionId, preparation)
      throw new TerminalAttachCanceledError(sessionId)
    }
    anchor.deadline = anchor.at + execution.remainingMs!
    if (performance.now() >= anchor.deadline) {
      this.cancelPreparation(preparation)
      this.finish(sessionId, preparation)
      throw new TerminalAttachCanceledError(sessionId)
    }
    preparation.settlement!.noChild = false
    if (preparation.cancelTimer) {
      clearTimeout(preparation.cancelTimer)
    }
    preparation.cancelTimer = setTimeout(
      () => this.cancelPreparation(preparation),
      anchor.deadline - performance.now()
    )
    preparation.cancelTimer.unref?.()
    return preparation
  }

  isCanceled(preparation: PendingPtySpawnPreparation): boolean {
    return (
      preparation.canceled ||
      (preparation.switchAnchor !== undefined &&
        performance.now() >= preparation.switchAnchor.deadline)
    )
  }

  async prepareUnlessCanceled(
    sessionId: string,
    preparation: PendingPtySpawnPreparation
  ): Promise<void> {
    // Return protocol cancellation before shutdown tears down the client transport.
    const cancellation = this.cancellationByPreparation.get(preparation)
    const work = this.preparePtySpawn()
    if (preparation.settlement) {
      preparation.settlement.preparationWork = work
    }
    const preparationTask = cancellation ? Promise.race([work, cancellation.promise]) : work
    await preparationTask
    if (this.isCanceled(preparation)) {
      throw new TerminalAttachCanceledError(sessionId)
    }
  }

  finish(sessionId: string, preparation: PendingPtySpawnPreparation): void {
    if (preparation.cancelTimer) {
      clearTimeout(preparation.cancelTimer)
    }
    this.cancellationByPreparation.delete(preparation)
    if (preparation.settlement) {
      const settlement = preparation.settlement
      void Promise.resolve(settlement.preparationWork)
        .catch(() => {})
        .then(() => {
          settlement.producerFinished = true
          settlement.finish()
          if (settlement.noChild || settlement.failed) {
            this.retireSettled(sessionId, preparation)
          }
        })
    }
    const pendingForSession = this.pending.get(sessionId)
    pendingForSession?.delete(preparation)
    if (pendingForSession?.size === 0) {
      this.pending.delete(sessionId)
    }
  }

  cancel(sessionId: string, request?: { clientId: string; requestId?: string }): boolean {
    const pendingForSession = this.pending.get(sessionId)
    if (!pendingForSession) {
      return false
    }
    let canceled = false
    for (const preparation of pendingForSession) {
      if (
        request &&
        (preparation.clientId !== request.clientId ||
          (request.requestId !== undefined && preparation.requestId !== request.requestId))
      ) {
        continue
      }
      this.cancelPreparation(preparation)
      canceled = true
    }
    return canceled
  }

  async settle(
    sessionId: string,
    clientId: string,
    requestId: string | undefined,
    identity: { anchor: string; invocationId: string },
    notifyExit?: (result: CreateOrAttachResult, code: number) => void
  ): Promise<CreateOrAttachSettlement> {
    const key = JSON.stringify([sessionId, clientId, identity.anchor])
    const preparation = this.retained.get(key)
    if (preparation && 'outcome' in preparation) {
      return preparation.requestId === requestId &&
        preparation.invocationId === identity.invocationId
        ? { outcome: preparation.outcome }
        : { outcome: 'unknown' }
    }
    const preparedOnly =
      preparation?.switchAnchor?.deadline === Infinity && preparation.requestId === identity.anchor
    if (
      !preparation ||
      typeof requestId !== 'string' ||
      (!preparedOnly && preparation.requestId !== requestId) ||
      preparation.switchAnchor?.invocationId !== identity.invocationId ||
      !preparation.settlement
    ) {
      return { outcome: 'unknown' }
    }
    this.cancelPreparation(preparation)
    if (preparedOnly) {
      preparation.requestId = requestId
      this.finish(sessionId, preparation)
    }
    const settlement = preparation.settlement
    settlement.notifyExit = notifyExit
    await settlement.completion
    if (!settlement.noChild) {
      await settlement.reconcile?.()
    }
    if (settlement.failed) {
      await settlement.physicalCompletion
      return { outcome: 'failed' }
    }
    if (settlement.noChild) {
      return { outcome: 'exited' }
    }
    return settlement.result
      ? { outcome: 'owned', result: settlement.result }
      : { outcome: 'unknown' }
  }

  trackPhysical(
    sessionId: string,
    preparation: PendingPtySpawnPreparation,
    completion: Promise<void>,
    exitCode?: () => number | null
  ): void {
    if (!preparation.settlement) {
      return
    }
    preparation.settlement.physicalCompletion = completion
    if (!exitCode) {
      preparation.settlement.failed = true
    }
    const reference = new WeakRef(preparation)
    void completion.then(() => {
      const current = reference.deref()
      if (!current) {
        return
      }
      const result = current.settlement?.result
      if (result && exitCode) {
        current.settlement?.notifyExit?.(result, exitCode() ?? -1)
      }
      this.retireSettled(sessionId, current)
    })
  }

  retireSettled(sessionId: string, preparation: PendingPtySpawnPreparation): void {
    compactDaemonSpawnPreparation(this.retained, sessionId, preparation)
  }

  release(
    ...args: Parameters<typeof releaseDaemonSpawnPreparation> extends [unknown, ...infer A]
      ? A
      : never
  ): boolean {
    return releaseDaemonSpawnPreparation(this.retained, ...args)
  }

  cancelForClient(clientId: string): void {
    for (const pendingForSession of this.pending.values()) {
      for (const preparation of pendingForSession) {
        if (preparation.clientId === clientId) {
          this.cancelPreparation(preparation)
        }
      }
    }
  }
  private cancelPreparation(preparation: PendingPtySpawnPreparation): void {
    preparation.canceled = true
    preparation.controller.abort()
    this.cancellationByPreparation.get(preparation)?.resolve()
  }

  cancelAll(): void {
    for (const sessionId of this.pending.keys()) {
      this.cancel(sessionId)
    }
  }
}
