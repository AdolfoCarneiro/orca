import { isProvenProcessExit } from '../../shared/terminal-exit-cause'
import type { DaemonClient } from './client'
import { sameEndpointIdentity } from './daemon-endpoint-incarnation'
import { STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION } from './daemon-protocol-version'
import { DaemonPtyRuntimeState, type PendingDaemonSpawnOperation } from './daemon-pty-runtime-state'
import type { DaemonPtySpawnContext } from './daemon-pty-spawn-request'
import type {
  CancelCreateOrAttachResult,
  CancelCreateOrAttachRequest,
  CreateOrAttachResult
} from './types'

export abstract class DaemonPtySpawnSettlement extends DaemonPtyRuntimeState {
  protected readonly switchSpawnSettlements = new Map<
    PendingDaemonSpawnOperation,
    NonNullable<PendingDaemonSpawnOperation['switchSettlement']>
  >()
  private readonly switchReleaseCleanup = new Map<
    string,
    {
      client: DaemonClient
      payload: CancelCreateOrAttachRequest['payload']
    }
  >()
  private switchReleaseDrain: Promise<void> | undefined

  protected async reconcileSwitchSpawns(): Promise<void> {
    await Promise.all([...this.switchSpawnSettlements.values()].map((owner) => owner.recover()))
  }

  async settleSwitchWorkForReplacement(): Promise<void> {
    await this.reconcileSwitchSpawns()
    await Promise.all([...this.switchSpawnSettlements.values()].map((owner) => owner.completion))
  }

  inheritSwitchReleaseCleanup(previous: DaemonPtySpawnSettlement): void {
    for (const [key, entry] of previous.switchReleaseCleanup) {
      this.switchReleaseCleanup.set(key, entry)
    }
    previous.switchReleaseCleanup.clear()
    this.drainSwitchReleaseCleanup()
  }

  protected drainSwitchReleaseCleanup(): void {
    if (this.switchReleaseDrain || !this.switchReleaseCleanup.size) {
      return
    }
    const batch = new Map(this.switchReleaseCleanup)
    this.switchReleaseDrain = Promise.all(
      [...batch].map(async ([key, entry]) => {
        try {
          await entry.client.withRetainedConnection(async () => {
            await entry.client.ensureConnected()
            const endpoint = entry.payload.release?.endpoint
            const current = entry.client.getDaemonIdentity()
            if (!endpoint || !current) {
              return
            }
            if (!sameEndpointIdentity(endpoint, current)) {
              // Only consumed GC debt is obsolete at an authenticated replacement endpoint.
              if (this.switchReleaseCleanup.get(key) === entry) {
                this.switchReleaseCleanup.delete(key)
              }
              return
            }
            const result = await entry.client.request<CancelCreateOrAttachResult>(
              'cancelCreateOrAttach',
              entry.payload,
              5000
            )
            if (result.released === true && this.switchReleaseCleanup.get(key) === entry) {
              this.switchReleaseCleanup.delete(key)
            }
          })
        } catch {
          /* Release debt never holds physical completion or user work. */
        }
      })
    )
      .then(() => {})
      .finally(() => {
        this.switchReleaseDrain = undefined
        if ([...this.switchReleaseCleanup].some(([key, entry]) => batch.get(key) !== entry)) {
          this.drainSwitchReleaseCleanup()
        }
      })
  }

  protected abstract ensureConnected(deadlineMs?: number): Promise<void>
  protected abstract withDaemonRetry<T>(fn: () => Promise<T>): Promise<T>

  protected observeSwitchSpawn(
    context: DaemonPtySpawnContext,
    requestId: string,
    anchor: string | undefined,
    preparedEndpoint: ReturnType<DaemonClient['getDaemonIdentity']>,
    contract = 'creation-settlement-v1'
  ): void {
    const { opts } = context
    const authority = opts.switchExecution
    const endpoint = preparedEndpoint ?? this.client.getDaemonIdentity()
    if (!authority || (contract !== 'ordinary' && !anchor)) {
      return
    }
    const completion = Promise.withResolvers<void>()
    const originalAnchor = anchor
    let consumed = false
    const dispatchedClient = this.client
    const dispatchedSessionId = context.sessionId
    let recovery: Promise<void> | undefined
    let ordinaryIncarnation: string | undefined
    const consume = (outcome: 'exited' | 'adopted' | 'failed', incarnationId?: string) => {
      if (consumed) {
        return
      }
      consumed = true
      completion.resolve()
      if (this.switchSpawnSettlements.get(context.operation) === owner) {
        this.switchSpawnSettlements.delete(context.operation)
      }
      if (endpoint && originalAnchor && contract !== 'ordinary') {
        const payload = {
          sessionId: dispatchedSessionId,
          requestId,
          release: {
            invocationId: authority.invocationId,
            anchor: originalAnchor,
            endpoint,
            outcome,
            ...(incarnationId ? { incarnationId } : {})
          }
        }
        this.switchReleaseCleanup.set(
          JSON.stringify([endpoint, dispatchedSessionId, requestId, originalAnchor]),
          { client: dispatchedClient, payload }
        )
        this.drainSwitchReleaseCleanup()
      }
    }
    const recover = (): Promise<void> => {
      if (consumed) {
        return owner.completion
      }
      if (recovery) {
        return recovery
      }
      recovery = this.withDaemonRetry(async () => {
        await this.ensureConnected()
        if (consumed) {
          return
        }
        const current = this.client.getDaemonIdentity()
        if (!endpoint || !current || !sameEndpointIdentity(endpoint, current)) {
          throw new Error('Terminal owner unavailable; reconnect and try again')
        }
        if (contract === 'ordinary') {
          const exited =
            ordinaryIncarnation &&
            (context.operation.exitsBySessionId.get(dispatchedSessionId) ?? []).some(
              (exit) => exit.incarnationId === ordinaryIncarnation && isProvenProcessExit(exit.code)
            )
          if (exited) {
            consume('exited')
            return
          }
          if (this.protocolVersion < STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION) {
            throw new Error('Terminal owner unavailable; reconnect and try again')
          }
          const result = await this.client.request<CreateOrAttachResult>(
            'createOrAttach',
            {
              sessionId: dispatchedSessionId,
              cols: context.effectiveCols,
              rows: context.effectiveRows,
              attachOnly: true
            },
            5000
          )
          if (consumed) {
            return
          }
          if (
            result.isNew ||
            !result.incarnationId ||
            (ordinaryIncarnation && ordinaryIncarnation !== result.incarnationId)
          ) {
            throw new Error('Terminal owner has not confirmed physical completion; try again')
          }
          ordinaryIncarnation = result.incarnationId
          this.sessionIncarnations.set(dispatchedSessionId, ordinaryIncarnation)
          this.activeSessionIds.add(dispatchedSessionId)
          // Attach observes the exact live resource; only ordinary adoption or its positive exit settles it.
          throw new Error('Terminal is still running; open its tab or close it and try again')
        }
        if (!originalAnchor) {
          throw new Error('Terminal owner unavailable; reconnect and try again')
        }
        const response = await this.client.request<CancelCreateOrAttachResult>(
          'cancelCreateOrAttach',
          {
            sessionId: dispatchedSessionId,
            requestId,
            settlement: {
              invocationId: authority.invocationId,
              anchor: originalAnchor,
              endpoint
            }
          },
          5000
        )
        if (consumed) {
          return
        }
        if (response.retention !== contract) {
          throw new Error('Terminal owner has not confirmed physical completion; try again')
        }
        if (
          response.settlement?.outcome === 'exited' ||
          (contract === 'creation-settlement-v1' && response.settlement?.outcome === 'failed')
        ) {
          consume(response.settlement.outcome)
          return
        }
        if (response.settlement?.outcome === 'owned') {
          const result = response.settlement.result
          const id = result.agentSessionEnsure?.owner.ptyId ?? dispatchedSessionId
          // Publish the actual surviving incarnation through ordinary adapter inventory.
          if (result.incarnationId) {
            this.sessionIncarnations.set(id, result.incarnationId)
          }
          this.activeSessionIds.add(id)
        }
        throw new Error('Terminal owner has not confirmed physical completion; try again')
      })
        .catch((error) => {
          if (!consumed) {
            throw error
          }
        })
        .finally(() => {
          recovery = undefined
        })
      return recovery
    }
    const owner = {
      completion: completion.promise,
      recover,
      consume,
      adopt: (incarnationId: string) => {
        if (contract === 'ordinary' && ordinaryIncarnation === incarnationId) {
          consume('adopted', incarnationId)
        }
      }
    }
    context.operation.switchSettlement = owner
    this.switchSpawnSettlements.set(context.operation, owner)
    authority.trackPhysical?.(owner.completion, recover)
  }
}
