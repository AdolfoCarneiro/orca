import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { mainTerminalSourceInputs } from '../../terminal/surface/pty-pane-query'
import { runtimeLayoutLoadContext } from '../../workspace-layout-projection'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../db'
import type { CrewReadDependencies } from './crew-read-model'
import { conversationRecordReader } from '../structured-session-lineage'
import { peekOpenedAgentSessionRecordStore } from '../../agent-session-record-store-slot'
import { isDeepStrictEqual } from 'node:util'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { crewWorkspaceNames } from './crew-workspace-names'
import { sessionCrewChanges, type CrewInvalidation } from './crew-changes'

type CrewRuntimeWatchDependencies = {
  store: RuntimeStore | null
  watchChanges: (wake: (facets: CrewInvalidation) => void) => () => void
  watchTransitions: (wake: () => void) => () => void
  watchClient: (wake: (event: RuntimeClientEvent) => void) => () => void
}

export function watchCrewRuntimeSources(
  deps: CrewRuntimeWatchDependencies,
  wake: (facets: CrewInvalidation) => void
) {
  const hostIds = () => deps.store?.getWorkspaceSessionHostIds?.() ?? (['local'] as const)
  const namesByHost = new Map(
    hostIds().map((hostId) => [
      hostId,
      crewWorkspaceNames(deps.store?.getWorkspaceSession?.(hostId))
    ])
  )
  const topology = (id: ReturnType<typeof hostIds>[number]) =>
    mainTerminalSourceInputs(
      deps.store?.getWorkspaceSession?.(id),
      runtimeLayoutLoadContext(deps.store, id)
    )
  const topologyByHost = new Map(
    ORCA_LAYOUT_OWNER_IS_MAIN ? hostIds().map((id) => [id, topology(id)]) : []
  )
  const disposers = [
    deps.watchChanges(wake),
    sessionCrewChanges.subscribe(wake),
    deps.watchTransitions(() => wake(new Set(['status', 'names']))),
    deps.store?.onWorkspaceSessionWritten?.((hostId) => {
      for (const id of hostId === null ? hostIds() : [hostId]) {
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          const next = topology(id)
          if (!isDeepStrictEqual(topologyByHost.get(id), next)) {
            topologyByHost.set(id, next)
            wake(new Set(['topology']))
          }
        }
        const next = crewWorkspaceNames(deps.store?.getWorkspaceSession?.(id))
        if (!isDeepStrictEqual(namesByHost.get(id), next)) {
          namesByHost.set(id, next)
          wake(new Set(['names']))
        }
      }
    }) ?? (() => {}),
    deps.store?.onSettingsChanged?.((updates) => {
      if ('tabAutoGenerateTitle' in updates) {
        wake(new Set(['names']))
      }
    }) ?? (() => {}),
    deps.watchClient((event) => {
      if (
        event.type === 'terminalSideEffects' &&
        event.batch.facts.some((fact) => fact.kind === 'title')
      ) {
        wake(new Set(['names']))
      }
    })
  ]
  return () => disposers.forEach((dispose) => dispose())
}

export function readCrewRuntimeInputs(
  runtime: Pick<
    OrcaRuntimeService,
    | 'getTerminalWorktreeIdForHandle'
    | 'getTerminalProcessIncarnation'
    | 'getTerminalHandleForPaneKey'
    | 'getPaneKeyForTerminalHandle'
    | 'getTerminalPaneKey'
    | 'getOrchestrationFleetAgentStatusSnapshot'
    | 'createTerminalIdentityRawInputs'
    | 'createTerminalIdentityReadContext'
    | 'orchestrationSenderNames'
  >,
  db: OrchestrationDb | null,
  retainedDbExists: boolean,
  hostKey: string,
  previous?: CrewReadDependencies
): CrewReadDependencies {
  const store = peekOpenedAgentSessionRecordStore()
  const openContext =
    previous?.openRuntimeIdentityRead ??
    (() => {
      const raw = runtime.createTerminalIdentityRawInputs()
      return () => runtime.createTerminalIdentityReadContext(raw)
    })()
  const name = runtime.orchestrationSenderNames.captureCrewInputs()
  const openIdentityRead = () => {
    const context = openContext()
    return {
      processForHandle: (handle: string) => runtime.getTerminalProcessIncarnation(handle, context),
      liveHandle: (handle: string) =>
        runtime.getTerminalWorktreeIdForHandle(handle, context) !== null,
      handleForPane: (pane: string) => runtime.getTerminalHandleForPaneKey(pane, context),
      paneForHandle: (handle: string) => runtime.getPaneKeyForTerminalHandle(handle, context),
      name: (...args: Parameters<CrewReadDependencies['name']>) =>
        name(...args, (handle) => runtime.getTerminalPaneKey(handle, context))
    }
  }
  return {
    db,
    openIdentityRead,
    openRuntimeIdentityRead: openContext,
    retainedDbExists,
    hostKey,
    records: store ? conversationRecordReader(store) : null,
    processForHandle: (handle) => runtime.getTerminalProcessIncarnation(handle),
    liveHandle: (handle) => runtime.getTerminalWorktreeIdForHandle(handle) !== null,
    handleForPane: (pane) => runtime.getTerminalHandleForPaneKey(pane),
    paneForHandle: (handle) => runtime.getPaneKeyForTerminalHandle(handle),
    name,
    get statuses() {
      return runtime.getOrchestrationFleetAgentStatusSnapshot(openContext())
    }
  }
}
