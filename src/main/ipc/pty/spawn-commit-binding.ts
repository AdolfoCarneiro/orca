import { randomUUID } from 'node:crypto'
import type { Store } from '../../persistence'
import type { PersistPtyBindingArgs } from '../../persistence/loading-store/pty-binding-persistence'
import { ptyBindingIsRefused } from '../../persistence/loading-store/pty-binding-refusals'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { createTerminalSessionStateSaveFailureMessage } from '../../../shared/terminal-session-state-save-failure'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { IPtyProvider, PtySpawnResult } from '../../providers/pty-provider-contract'
import {
  isAbsentBindingReplay,
  PaneOwnerContentionError,
  type AbsentPaneBinding
} from './pane/pane-spawn-operation'
import { swapReplacedPaneBinding } from './pane/pane-owner-replacement'
import type { ReplacedPaneOwner } from './pane/replaced-pane-owner'
import { finishPtyShutdown } from './provider/liveness'
import { PtyExitProof } from '../../pty-exit-proof'
import { discardUnpersistedPtySpawn } from './pane/spawn-registration'
import type { AgentSessionSwitchAuthority } from '../../../shared/agent-session-switch-execution'

/** A lane's pane binding for its new process, saved before the spawn is acknowledged. */
export type PtySpawnPaneBinding = {
  store: Store
  binding: PersistPtyBindingArgs
  absentOwner?: AbsentPaneBinding
  /** What a refused bind throws; each lane's callers match on their own message. */
  refusal: 'terminal_pane_owner_changed' | 'terminal_split_source_not_found'
  failureLog: string
}

/** Saves the binding, or a swap over the replaced owner; a failed save discards the new process. */
export async function savePtySpawnPaneBinding(
  state: {
    result: PtySpawnResult
    provider: IPtyProvider
    replacedPaneOwner?: ReplacedPaneOwner | null
    args?: {
      switchExecution?: AgentSessionSwitchAuthority
    }
    deps: { runtime?: OrcaRuntimeService; sendPtySpawnedToRenderer?: (id: string) => void }
  },
  { store, binding, absentOwner, refusal, failureLog }: PtySpawnPaneBinding,
  connectionId: string | null | undefined
): Promise<void> {
  const replaced = state.replacedPaneOwner
  const observeAuthority = () => {
    try {
      state.args?.switchExecution?.check()
    } catch {
      state.result.switchOutcomeUnknown = true
    }
  }
  try {
    const persisted = replaced
      ? await store.persistPtyBinding(() => {
          observeAuthority()
          return swapReplacedPaneBinding(store, binding, replaced)()
        })
      : await persistFreshPaneBinding(store, binding, connectionId, absentOwner, observeAuthority)
    if (persisted === false) {
      throw new Error(refusal)
    }
    if (replaced) {
      // The swap holds the live binding now: a later failure must not retire it under the same id.
      state.replacedPaneOwner = null
    }
  } catch (err) {
    console.error(failureLog, err)
    if (state.args?.switchExecution) {
      if (await closeUnusedSwitchSpawn(state.provider, state.result)) {
        throw err
      }
      // A dispatched child can have acquired users during the durable wait; never generic-close it.
      state.result.switchOutcomeUnknown = true
      const recovered = { tabId: randomUUID(), leafId: randomUUID() }
      // Rehome the real child through ordinary topology creation, never overwrite the winner.
      const recovery: PersistPtyBindingArgs = {
        worktreeId: binding.worktreeId,
        ...recovered,
        ptyId: binding.ptyId,
        incarnationId: binding.incarnationId,
        startupCwd: binding.startupCwd,
        mayCreate: true
      }
      await store
        .persistPtyBinding(recovery, connectionId ? toSshExecutionHostId(connectionId) : undefined)
        .catch(() => false)
      // Even a failed disk remains an owned, visibly published runtime terminal, not a second start.
      state.result.switchRecoveredSurface = recovered
      Object.assign(binding, recovery)
      state.replacedPaneOwner = null
      return
    }
    await discardUnpersistedPtySpawn(state.provider, state.result, state.deps.runtime)
    if (
      err instanceof PaneOwnerContentionError ||
      (err instanceof Error && err.message === refusal)
    ) {
      throw err
    }
    throw Object.assign(new Error(createTerminalSessionStateSaveFailureMessage(err)), {
      agentSessionOperationOutcome: 'unknown' as const
    })
  }
}

/** Optional runtime stores delegate the same binding write without introducing an await when absent. */
export function persistFreshPaneBindingIfSupported(
  store: Partial<Pick<Store, 'persistPtyBinding' | 'getWorkspaceSession'>> | null | undefined,
  input: PersistPtyBindingArgs | (() => PersistPtyBindingArgs),
  connectionId?: string | null
): Promise<boolean> | undefined {
  if (!store?.persistPtyBinding || !store.getWorkspaceSession) {
    return undefined
  }
  return persistFreshPaneBinding(
    {
      persistPtyBinding: store.persistPtyBinding.bind(store),
      getWorkspaceSession: store.getWorkspaceSession.bind(store)
    },
    input,
    connectionId
  )
}

/** Runs inside the existing durable mutation, after source/topology checks and before any bind. */
export async function persistFreshPaneBinding(
  store: Pick<Store, 'persistPtyBinding' | 'getWorkspaceSession'>,
  input: PersistPtyBindingArgs | (() => PersistPtyBindingArgs),
  connectionId?: string | null,
  absentOwner?: AbsentPaneBinding,
  observeAuthority?: () => void
): Promise<boolean> {
  let targetChanged = false
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : undefined
  const persisted = await store.persistPtyBinding(() => {
    observeAuthority?.()
    const binding = typeof input === 'function' ? input() : input
    const session = store.getWorkspaceSession(hostId)
    const paneKey = makePaneKey(binding.tabId, binding.leafId)
    if (ptyBindingIsRefused(binding, session, binding.worktreeId, paneKey, [])) {
      return binding
    }
    const bound = session.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[binding.leafId]
    const stamp = session.terminalPtyIncarnationsByPaneKey?.[paneKey]
    if (
      bound &&
      (bound !== binding.ptyId || stamp !== binding.incarnationId) &&
      !isAbsentBindingReplay(absentOwner, bound, stamp)
    ) {
      targetChanged = true
      return null
    }
    return binding
  }, hostId)
  if (targetChanged) {
    throw new PaneOwnerContentionError()
  }
  return persisted
}

/** Only the original unused physical witness can authorize cleanup after a dispatched result. */
export async function closeUnusedSwitchSpawn(
  provider: IPtyProvider,
  result: PtySpawnResult
): Promise<boolean> {
  if (
    !result.switchCleanupWitness ||
    !result.incarnationId ||
    result.isReattach ||
    result.agentSessionEnsure?.disposition === 'adopted'
  ) {
    return false
  }
  const cleanup = await provider
    .killFenced?.({
      id: result.id,
      expectedIncarnationId: result.incarnationId,
      requireNoAgentOwner: false,
      requireUnattached: false,
      switchCondition: {
        token: result.switchCleanupWitness,
        remainingMs: 8_000,
        ownedSpawn: true,
        claimGeneration: result.agentSessionEnsure?.owner.generation
      }
    })
    .catch(() => undefined)
  if (cleanup?.outcome !== 'ended' && cleanup?.outcome !== 'already_exited') {
    return false
  }
  finishPtyShutdown(
    result.id,
    null,
    undefined,
    PtyExitProof.from('shutdown-acknowledged', result.incarnationId)
  )
  return true
}
