import type {
  PendingPtySpawnPreparation,
  CompletedPreparation
} from './daemon-pty-spawn-preparation-state'
export function releaseDaemonSpawnPreparation(
  retained: Map<string, PendingPtySpawnPreparation | CompletedPreparation>,
  sessionId: string,
  clientId: string,
  requestId: unknown,
  release: {
    anchor: string
    invocationId: string
    outcome: 'exited' | 'adopted' | 'failed'
    incarnationId?: string
  }
): boolean {
  const key = JSON.stringify([sessionId, clientId, release.anchor])
  const entry = retained.get(key)
  // GC acknowledgement is distinct from physical proof and is safe to repeat after deletion.
  if (!entry) {
    return true
  }
  if (typeof requestId !== 'string' || entry.requestId !== requestId) {
    return false
  }
  if ('outcome' in entry) {
    if (
      entry.invocationId !== release.invocationId ||
      (release.outcome === 'failed' ? entry.outcome !== 'failed' : entry.outcome === 'failed') ||
      (release.outcome === 'adopted' &&
        (!release.incarnationId || release.incarnationId !== entry.incarnationId))
    ) {
      return false
    }
  } else {
    const settlement = entry.settlement
    if (
      entry.switchAnchor?.invocationId !== release.invocationId ||
      !settlement?.producerFinished
    ) {
      return false
    }
    if (release.outcome === 'failed') {
      // Pending failed dependencies must compact before their terminal fact can be released.
      return false
    } else if (settlement.failed) {
      return false
    } else if (release.outcome === 'exited') {
      if (!settlement.noChild) {
        return false
      }
    } else if (
      !release.incarnationId ||
      settlement.result?.incarnationId !== release.incarnationId
    ) {
      return false
    }
  }
  retained.delete(key)
  if (!('outcome' in entry) && entry.settlement) {
    entry.settlement.result = undefined
    entry.settlement.reconcile = undefined
    entry.settlement.notifyExit = undefined
    entry.settlement.preparationWork = undefined
    entry.settlement.physicalCompletion = undefined
  }
  return true
}

export function compactDaemonSpawnPreparation(
  retained: Map<string, PendingPtySpawnPreparation | CompletedPreparation>,
  sessionId: string,
  preparation: PendingPtySpawnPreparation
): void {
  const settlement = preparation.settlement
  if (!settlement) {
    return
  }
  if (!settlement.failed) {
    settlement.noChild = true
  }
  void Promise.all([
    settlement.completion,
    settlement.failed ? settlement.physicalCompletion : undefined
  ]).then(() => {
    const anchor = preparation.switchAnchor
    const key = JSON.stringify([sessionId, preparation.clientId, anchor?.token])
    if (!anchor || retained.get(key) !== preparation || !settlement.producerFinished) {
      return
    }
    retained.set(key, {
      outcome: settlement.failed ? 'failed' : 'exited',
      clientId: preparation.clientId,
      requestId: preparation.requestId,
      anchor: anchor.token,
      invocationId: anchor.invocationId,
      ...(settlement.result?.incarnationId
        ? { incarnationId: settlement.result.incarnationId }
        : {})
    })
    settlement.result = undefined
    settlement.reconcile = undefined
    settlement.notifyExit = undefined
    settlement.preparationWork = undefined
    settlement.physicalCompletion = undefined
  })
}
