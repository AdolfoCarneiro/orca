import type { DaemonPtySpawnContext } from './daemon-pty-spawn-context'
import { DaemonPtySpawnSettlement } from './daemon-pty-spawn-settlement'
import {
  SESSION_SWITCH_PHYSICAL_PROTOCOL_VERSION,
  HISTORY_SEED_TRANSFER_PROTOCOL_VERSION
} from './daemon-protocol-version'
import type { SpawnIntent } from '../../shared/host-spawn-admission'
import type { ColdRestorePayload } from './cold-restore-payload-cache'
import type { DaemonAuditObservation } from './daemon-audit-classifier'
import type {
  PendingDaemonSpawnOperation,
  SnapshotCheckpointResult
} from './daemon-pty-runtime-state'
import type { DaemonClient } from './client'
import { isDaemonGoneError } from './daemon-endpoint-errors'
import type { ColdRestoreInfo } from './history-reader'
import { NdjsonLineTooLongError } from './ndjson'
import {
  iterateTerminalHistorySeedChunks,
  measureTerminalHistorySeed,
  TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS
} from './terminal-history-seed-chunks'
import type { CreateOrAttachResult, GetSnapshotResult } from './types'
import type { PtySpawnResult } from '../providers/pty-provider-contract'
import { resolveSafePtyDefaultCwd } from '../providers/pty-default-cwd'
import { isMissingWorkingDirectoryError } from '../providers/working-directory-validation'
export { type DaemonPtySpawnContext } from './daemon-pty-spawn-context'

/** A daemon kept running across an update trusts `interactive` even for a claimed resume. */
function forwardedSpawnIntent(intent: SpawnIntent, claim: unknown): SpawnIntent {
  return intent === 'interactive' && claim !== undefined ? 'automatic-restore' : intent
}

export abstract class DaemonPtySpawnRequest extends DaemonPtySpawnSettlement {
  protected abstract takeSnapshotAndCheckpoint(
    sessionId: string,
    opts: {
      teardown: boolean
      forceLiveSnapshot?: boolean
      requireContinuityProof?: boolean
    }
  ): Promise<SnapshotCheckpointResult>
  protected abstract markSessionDirty(sessionId: string): void
  protected abstract writeSessionCheckpoint(
    sessionId: string,
    opts: { final: boolean; teardown: boolean }
  ): Promise<'done' | 'deferred'>
  protected abstract releasePendingRespawnAdoptionLease(): void
  protected abstract setupEventRouting(): void
  protected abstract scheduleCheckpointTimer(): void
  protected abstract stopCheckpointTimer(): void
  protected abstract recordAuthenticatedIdentity(): void
  protected abstract runExclusiveCheckpoint(
    operation: () => Promise<void>,
    options?: { rescheduleDirty?: boolean; callerDeadlineMs?: number }
  ): Promise<boolean>
  protected abstract checkpointAllSessions(): Promise<void>
  protected abstract ensureConnected(deadlineMs?: number): Promise<void>
  protected abstract withHistorySpawnLock<T>(
    sessionId: string,
    operation: () => Promise<T>
  ): Promise<T>
  protected abstract reconnectAfterWriteFailure(): void
  protected abstract checkpointSessions(
    sessionIds: Iterable<string>,
    opts?: { final?: boolean; teardown?: boolean }
  ): Promise<Set<string>>
  protected abstract publishAuditObservation(observation: DaemonAuditObservation): void
  protected abstract isRetiredEndpointTokenMissing(): boolean
  protected abstract withDaemonRetry<T>(fn: () => Promise<T>): Promise<T>
  protected abstract replaceUnhealthyMacResolverDaemonBeforeNewPty(): Promise<void>
  protected abstract replaceStaleBundleDaemonBeforeNewPty(): Promise<void>
  protected abstract replaceSeveredMacTccDaemonBeforeNewPty(): Promise<void>
  abstract setPtyBackgrounded(id: string, background: boolean): void
  abstract getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null>
  protected abstract resultForExitBeforeSpawnReply(
    sessionId: string,
    result: CreateOrAttachResult,
    operation: PendingDaemonSpawnOperation
  ): PtySpawnResult | null
  protected abstract buildColdRestorePayload(
    restoreInfo: ColdRestoreInfo
  ): ColdRestorePayload | null
  protected abstract overlayDurableRestoreSnapshot(
    sessionId: string,
    liveSnapshot: NonNullable<GetSnapshotResult['snapshot']>,
    scrollbackRows?: number
  ): Promise<NonNullable<GetSnapshotResult['snapshot']>>

  protected async createOrAttachSpawn(
    context: DaemonPtySpawnContext,
    historySeedSegments: readonly string[] | null
  ): Promise<CreateOrAttachResult> {
    let anchor: string | undefined
    const requestCreateOrAttach = async (
      historySeed: string | undefined,
      historySeedTransferId: string | undefined
    ) => {
      const { opts } = context
      let strong = Boolean(
        opts.switchExecution && this.protocolVersion >= SESSION_SWITCH_PHYSICAL_PROTOCOL_VERSION
      )
      let preparedEndpoint: ReturnType<DaemonClient['getDaemonIdentity']> = null
      const observeDispatch = (requestId: string, contract = 'creation-settlement-v1') =>
        this.observeSwitchSpawn(context, requestId, anchor, preparedEndpoint, contract)

      try {
        if (context.operation.switchSettlement) {
          throw new Error('Terminal creation was interrupted; try again')
        }
        if (opts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        opts.switchExecution?.check()
        if (opts.switchExecution && strong && !anchor) {
          preparedEndpoint = this.client.getDaemonIdentity()
          const prepared = await this.client.request<{ anchor: string; retention?: string }>(
            'createOrAttach',
            {
              sessionId: context.sessionId,
              cols: context.effectiveCols,
              rows: context.effectiveRows,
              switchExecution: { phase: 'prepare', invocationId: opts.switchExecution.invocationId }
            },
            Math.max(1, opts.switchExecution.remaining()),
            opts.signal
          )
          if (
            prepared.retention !== 'creation-settlement-v1' ||
            typeof prepared.anchor !== 'string' ||
            !prepared.anchor
          ) {
            // Negotiate before destination dispatch; an unaware peer keeps its ordinary route.
            if (typeof prepared.anchor === 'string' && prepared.anchor) {
              if (prepared.retention === 'consumer-release-v1' && preparedEndpoint) {
                // Known old prepared-only cleanup uses the same exact owner, never a strong commit.
                anchor = prepared.anchor
                observeDispatch(anchor, 'consumer-release-v1')
                await context.operation.switchSettlement!.recover()
                context.operation.switchSettlement = undefined
                anchor = undefined
              } else {
                await this.client.request(
                  'cancelCreateOrAttach',
                  { sessionId: context.sessionId, requestId: prepared.anchor },
                  Math.max(1, opts.switchExecution.remaining())
                )
              }
            }
            strong = false
          }
          if (strong) {
            anchor = prepared.anchor
          }
          opts.switchExecution.check()
        }
        const payload = {
          ...(opts.switchExecution && strong
            ? {
                switchExecution: {
                  phase: 'commit' as const,
                  contract: 'creation-settlement-v1' as const,
                  invocationId: opts.switchExecution.invocationId,
                  anchor,
                  remainingMs: opts.switchExecution.remaining()
                }
              }
            : {}),
          sessionId: context.sessionId,
          cols: context.effectiveCols,
          rows: context.effectiveRows,
          cwd: context.attachOnly ? undefined : context.effectiveCwd,
          env: context.attachOnly ? undefined : opts.env,
          envToDelete: context.attachOnly ? undefined : opts.envToDelete,
          command: context.attachOnly ? undefined : opts.command,
          startupCommandDelivery: context.attachOnly ? undefined : opts.startupCommandDelivery,
          launchAgent: context.attachOnly ? undefined : opts.launchAgent,
          ...(context.attachOnly && !context.emulateLegacyAttachOnly ? { attachOnly: true } : {}),
          shellOverride: context.attachOnly ? undefined : opts.shellOverride,
          terminalShellArgs: context.attachOnly ? undefined : opts.terminalShellArgs,
          terminalWindowsWslDistro: context.attachOnly ? undefined : opts.terminalWindowsWslDistro,
          terminalWindowsPowerShellImplementation: context.attachOnly
            ? undefined
            : opts.terminalWindowsPowerShellImplementation,
          shellReadySupported: context.attachOnly ? false : context.shellReadySupported,
          ...(!context.attachOnly && context.shellReadyTimeoutMs !== undefined
            ? { shellReadyTimeoutMs: context.shellReadyTimeoutMs }
            : {}),
          ...(historySeed ? { historySeed } : {}),
          ...(historySeedTransferId ? { historySeedTransferId } : {}),
          ...(this.supportsStartupIngress && !context.attachOnly && opts.startupIngress
            ? { startupIngress: opts.startupIngress }
            : {}),
          ...(!context.attachOnly && opts.spawnIntent
            ? { spawnIntent: forwardedSpawnIntent(opts.spawnIntent, opts.agentSessionEnsure) }
            : {}),
          ...(!context.attachOnly && opts.agentSessionEnsure
            ? { agentSessionEnsure: opts.agentSessionEnsure }
            : {})
        }
        const result = await (opts.switchExecution
          ? this.client.request<CreateOrAttachResult>(
              'createOrAttach',
              payload,
              Math.max(1, opts.switchExecution.remaining()),
              opts.signal,
              (requestId) =>
                observeDispatch(requestId, strong ? 'creation-settlement-v1' : 'ordinary')
            )
          : opts.signal
            ? this.client.request<CreateOrAttachResult>(
                'createOrAttach',
                payload,
                undefined,
                opts.signal
              )
            : this.client.request<CreateOrAttachResult>('createOrAttach', payload))
        return result
      } catch (error) {
        if (anchor && !context.operation.switchSettlement) {
          observeDispatch(anchor)
        }
        throw error
      }
    }

    let historySeedUnavailable = false
    const deliverSeedAndCreate = async (): Promise<CreateOrAttachResult> => {
      if (!historySeedSegments || historySeedSegments.length === 0) {
        return requestCreateOrAttach(undefined, undefined)
      }
      const metrics = measureTerminalHistorySeed(historySeedSegments)
      if (metrics.codeUnits <= TERMINAL_HISTORY_INLINE_SEED_CODE_UNITS) {
        try {
          return await requestCreateOrAttach(historySeedSegments.join(''), undefined)
        } catch (error) {
          if (!(error instanceof NdjsonLineTooLongError)) {
            throw error
          }
          historySeedUnavailable = true
          return requestCreateOrAttach(undefined, undefined)
        }
      }
      if (this.protocolVersion < HISTORY_SEED_TRANSFER_PROTOCOL_VERSION) {
        historySeedUnavailable = true
        return requestCreateOrAttach(undefined, undefined)
      }

      let transferId: string | undefined
      try {
        const started = await this.client.request<{ transferId: string }>(
          'startHistorySeedTransfer',
          metrics
        )
        transferId = started.transferId
        let index = 0
        for (const data of iterateTerminalHistorySeedChunks(historySeedSegments)) {
          await this.client.request('appendHistorySeedTransfer', { transferId, index, data })
          index += 1
        }
        await this.client.request('finishHistorySeedTransfer', { transferId })
      } catch (error) {
        if (transferId) {
          await this.client.request('abortHistorySeedTransfer', { transferId }).catch(() => {})
        }
        if (isDaemonGoneError(error)) {
          throw error
        }
        historySeedUnavailable = true
        return requestCreateOrAttach(undefined, undefined)
      }
      return requestCreateOrAttach(undefined, transferId)
    }
    const requestedCwd = context.opts.cwd ?? resolveSafePtyDefaultCwd()
    const result = await deliverSeedAndCreate().catch((error: unknown) => {
      const recovered = context.restoreInfo
      // Why: the folder a pane slept in can be deleted before it wakes; it then opens where it
      // was asked to, as it did before the folder was kept.
      if (
        !recovered ||
        context.effectiveCwd === requestedCwd ||
        !isMissingWorkingDirectoryError(error)
      ) {
        throw error
      }
      context.effectiveCwd = requestedCwd
      context.restoreInfo = { ...recovered, cwd: requestedCwd }
      return deliverSeedAndCreate()
    })
    return historySeedUnavailable && result.historySeeded === undefined
      ? { ...result, historySeeded: false }
      : result
  }
}
