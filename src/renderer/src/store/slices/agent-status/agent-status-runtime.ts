import type { SessionStateCreator } from '@/store/session-source-write-boundary'
import type { AppState } from '../../types'
import type { AgentStatusBatchTransaction, AgentStatusBatchUpdate } from './agent-status-contract'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { GeneratedTabTitleUpdate } from '../terminal-tab-title-batch'
import { createFreshnessScheduler } from './agent-status-freshness-scheduler'
import {
  editSessionSource,
  unwrapSessionSourceWrite,
  composeSessionSourceWrites,
  type SessionSourceUpdate,
  type SessionSourcePartial
} from '../../session-source-edits'

export type AgentStatusStateUpdate = SessionSourceUpdate<AppState>

export type AgentStatusRuntime = {
  get: () => AppState
  set: (update: AgentStatusStateUpdate) => void
  runAfterCommit: (effect: () => void) => void
  applyGeneratedTabTitleUpdate: (update: GeneratedTabTitleUpdate) => void
  requestFreshness: (acceptedInBatch: boolean) => void
  freshness: ReturnType<typeof createFreshnessScheduler>
  transactAgentStatuses: <Result>(
    operation: (transaction: AgentStatusBatchTransaction) => Result
  ) => Result
  clearSleepingAgentSessionsByPaneKey: (paneKeys: readonly string[]) => void
}

export function createAgentStatusRuntime(
  storeSet: Parameters<SessionStateCreator<AppState>>[0],
  storeGet: Parameters<SessionStateCreator<AppState>>[1],
  getActions: () => Pick<
    AgentStatusSlice,
    'setAgentStatus' | 'recordAgentProviderSession' | 'setAgentProgramStatus'
  >
): AgentStatusRuntime {
  let batchedAgentStatusState: AppState | null = null
  let batchedSourceWrites: SessionSourcePartial<AppState>[] | null = null
  // Staged in-place mutations cannot signal changes by identity; count every accepted write.
  let batchedAgentStatusRevision = 0
  let batchedAgentStatusEffects: (() => void)[] | null = null
  let batchedGeneratedTabTitleUpdates: GeneratedTabTitleUpdate[] | null = null
  let batchedAgentStatusFreshnessRequested = false
  const get = (): AppState => batchedAgentStatusState ?? storeGet()

  // Omit replace from this write type so no slice call can request replacement the batch cannot express.
  const set = (update: AgentStatusStateUpdate): void => {
    const staged = batchedAgentStatusState
    if (staged === null) {
      storeSet(update, false)
      return
    }
    const nextState = typeof update === 'function' ? update(staged) : update
    if (nextState === undefined) {
      return
    }
    batchedAgentStatusRevision += 1
    const { partial } = unwrapSessionSourceWrite(nextState)
    batchedSourceWrites?.push(nextState)
    // The staged root is private until commit; prior published values remain immutable.
    Object.assign(staged, partial)
  }

  const runAfterCommit = (effect: () => void): void => {
    if (batchedAgentStatusEffects) {
      batchedAgentStatusEffects.push(effect)
      return
    }
    effect()
  }

  const applyGeneratedTabTitleUpdate = (update: GeneratedTabTitleUpdate): void => {
    if (batchedGeneratedTabTitleUpdates) {
      batchedGeneratedTabTitleUpdates.push(update)
      return
    }
    if (update.options) {
      get().setGeneratedTabTitleFromAgentPrompt(update.paneKey, update.prompt, update.options)
    } else {
      get().setGeneratedTabTitleFromAgentPrompt(update.paneKey, update.prompt)
    }
  }

  const requestFreshness = (acceptedInBatch: boolean): void => {
    if (batchedAgentStatusState !== null) {
      batchedAgentStatusFreshnessRequested ||= acceptedInBatch
      return
    }
    freshness.scheduleDeferred()
  }

  const applyBatchedAgentStatusUpdate = (update: AgentStatusBatchUpdate): boolean => {
    if (!batchedAgentStatusState) {
      return false
    }
    const revisionBeforeUpdate = batchedAgentStatusRevision
    const actions = getActions()
    if (update.kind === 'providerSession') {
      actions.recordAgentProviderSession(
        update.paneKey,
        update.agent,
        update.providerSession,
        update.timing,
        update.routing,
        update.metadata
      )
    } else if (update.kind === 'programStatus') {
      actions.setAgentProgramStatus(update.paneKey, update.programStatus)
    } else {
      actions.setAgentStatus(
        update.paneKey,
        update.payload,
        update.terminalTitle,
        update.timing,
        update.routing,
        update.metadata
      )
    }
    return batchedAgentStatusRevision !== revisionBeforeUpdate
  }

  const batchTransaction: AgentStatusBatchTransaction = {
    getState: get,
    apply: applyBatchedAgentStatusUpdate,
    afterCommit: runAfterCommit
  }

  const transactAgentStatuses = <Result>(
    operation: (transaction: AgentStatusBatchTransaction) => Result
  ): Result => {
    if (batchedAgentStatusState) {
      return operation(batchTransaction)
    }
    const initialState = storeGet()
    const revisionAtStart = batchedAgentStatusRevision
    batchedAgentStatusState = { ...initialState }
    batchedSourceWrites = []
    batchedAgentStatusEffects = []
    batchedGeneratedTabTitleUpdates = []
    try {
      const result = operation(batchTransaction)
      const nextState = batchedAgentStatusState
      const effects = batchedAgentStatusEffects
      const generatedTabTitleUpdates = batchedGeneratedTabTitleUpdates
      const freshnessRequested = batchedAgentStatusFreshnessRequested
      const hasStagedWrites = batchedAgentStatusRevision !== revisionAtStart
      const sourceWrites = batchedSourceWrites
      batchedAgentStatusState = null
      batchedSourceWrites = null
      batchedAgentStatusEffects = null
      batchedGeneratedTabTitleUpdates = null
      batchedAgentStatusFreshnessRequested = false
      if (hasStagedWrites) {
        const patch = composeSessionSourceWrites(sourceWrites, true, {
          before: initialState,
          after: nextState
        })
        storeSet(patch, false)
      }
      if (generatedTabTitleUpdates.length > 0) {
        storeGet().setGeneratedTabTitlesFromAgentPrompts(generatedTabTitleUpdates)
      }
      if (freshnessRequested) {
        freshness.scheduleDeferred()
      }
      for (const effect of effects) {
        effect()
      }
      return result
    } finally {
      batchedAgentStatusState = null
      batchedSourceWrites = null
      batchedAgentStatusEffects = null
      batchedGeneratedTabTitleUpdates = null
      batchedAgentStatusFreshnessRequested = false
    }
  }

  const freshness = createFreshnessScheduler({
    getStatusEntries: () => get().agentStatusByPaneKey,
    bumpEpochs: () => {
      // Time-based staleness changes ordering without output; bump freshness/sort epochs at boundaries.
      set((s) => ({
        agentStatusEpoch: s.agentStatusEpoch + 1,
        sortEpoch: s.sortEpoch + 1
      }))
    }
  })

  // Why: launch configs retire with the pane; a woken pane registers its config before consuming this record.
  const clearSleepingAgentSessionsByPaneKey = (paneKeys: readonly string[]): void => {
    if (paneKeys.length === 0) {
      return
    }
    const uniquePaneKeys = new Set(paneKeys)
    set((s) => {
      const edit = editSessionSource(s)
      let changed = false
      for (const paneKey of uniquePaneKeys) {
        if (paneKey in s.sleepingAgentSessionsByPaneKey) {
          edit.remove('sleepingAgentSessionsByPaneKey', paneKey)
          changed = true
        }
      }
      if (!changed) {
        return undefined
      }
      return edit.finish()
    })
  }

  return {
    get,
    set,
    runAfterCommit,
    applyGeneratedTabTitleUpdate,
    requestFreshness,
    freshness,
    transactAgentStatuses,
    clearSleepingAgentSessionsByPaneKey
  }
}
