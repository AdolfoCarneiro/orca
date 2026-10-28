import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { MigrationUnsupportedPtyEntry } from '../../../shared/agent-status-types'

import type { PaneAliasNormalizationOptions } from './pane-identity-migration'

export {
  type WorkspaceSessionPaneIdentityRemap,
  remapSshRemotePtyLeaseLeafIds,
  normalizePersistedPaneIdentityState
} from './persisted-pane-identity-state'
import { SessionUnitIndex } from '../../../shared/session-unit-index'
import { SessionUnitReader } from '../../../shared/session-unit-reader'

import { rememberSessionPaneAliasRecipes } from './session-pane-alias-recipes'

import { agentHookServer } from '../../agent-hooks/server'

import { collectLegacyPaneKeyAliasesForTab } from './pane-identity-migration'
import { normalizeTerminalLayoutSnapshotForPersistence } from './terminal-layout-normalization'

export {
  remapAcknowledgedAgentPaneKeys,
  remapActivityClearedAtPaneKeys,
  remapManuallyUnreadTurnPaneKeys
} from './pane-key-remapping'

export function normalizeWorkspaceSessionPaneIdentities(
  session: WorkspaceSessionState,
  priorLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {},
  options: PaneAliasNormalizationOptions & { skipAliasTabIds?: ReadonlySet<string> } = {}
): {
  session: WorkspaceSessionState
  changed: boolean
  leafIdByInputLeafIdByTabId: Map<string, Map<string, string>>
  leafIdByPtyIdByTabId: Map<string, Map<string, string>>
  migrationUnsupportedEntries: MigrationUnsupportedPtyEntry[]
  legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[]
} {
  const reader = new SessionUnitReader(session, new SessionUnitIndex(session))
  const result = normalizeSessionPaneUnits(
    reader,
    Object.keys(session.terminalLayoutsByTabId ?? {}),
    options,
    priorLayoutsByTabId
  )
  return { ...result, session: reader.snapshot() }
}

export function normalizeSessionPaneUnits(
  reader: SessionUnitReader,
  tabIds: Iterable<string>,
  options: PaneAliasNormalizationOptions & { skipAliasTabIds?: ReadonlySet<string> } = {},
  priorLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
) {
  let changed = false
  const leafIdByInputLeafIdByTabId = new Map<string, Map<string, string>>()
  const leafIdByPtyIdByTabId = new Map<string, Map<string, string>>()
  const legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[] = []
  for (const tabId of tabIds) {
    const layout = reader.unit('terminalLayoutsByTabId', tabId).value
    if (!layout) {
      continue
    }
    const normalized = normalizeTerminalLayoutSnapshotForPersistence(
      layout,
      priorLayoutsByTabId
        ? priorLayoutsByTabId[tabId]
        : reader.unit('terminalLayoutsByTabId', tabId, 'prior').value
    )
    reader.write('terminalLayoutsByTabId', tabId, { present: true, value: normalized.snapshot })
    leafIdByInputLeafIdByTabId.set(tabId, normalized.leafIdByInputLeafId)
    if (!options.skipAliasTabIds?.has(tabId)) {
      const owner = reader
        .references('tab', tabId)
        .find((unit) => unit.field === 'tabsByWorktree')?.key
      const tab = owner
        ? reader.unit('tabsByWorktree', owner).value?.find((row) => row.id === tabId)
        : undefined
      const tabAliasEntries = collectLegacyPaneKeyAliasesForTab({
        tabId,
        tab,
        inputLayout: layout,
        normalizedLayout: normalized.snapshot,
        leafIdByInputLeafId: normalized.leafIdByInputLeafId
      })
      rememberSessionPaneAliasRecipes(normalized.snapshot, tabAliasEntries)
      // Split layouts can exceed V8's argument limit if aliases are spread into push.
      for (const entry of tabAliasEntries) {
        if (
          options.registerAliases !== false &&
          !agentHookServer.hasPaneKeyAlias(entry.legacyPaneKey, entry.stablePaneKey, entry.ptyId)
        ) {
          agentHookServer.registerPaneKeyAlias(
            entry.legacyPaneKey,
            entry.stablePaneKey,
            entry.ptyId
          )
        }
        if (entry.ptyId) {
          legacyPaneKeyAliasEntries.push({ ...entry, ptyId: entry.ptyId })
        } else {
          options.collectUnboundPaneAlias?.(entry)
        }
      }
    }
    const leafIdByPtyId = new Map<string, string>()
    const duplicatePtyIds = new Set<string>()
    for (const [leafId, ptyId] of Object.entries(normalized.snapshot.ptyIdsByLeafId ?? {})) {
      if (duplicatePtyIds.has(ptyId)) {
        continue
      }
      if (leafIdByPtyId.has(ptyId)) {
        leafIdByPtyId.delete(ptyId)
        duplicatePtyIds.add(ptyId)
        continue
      }
      leafIdByPtyId.set(ptyId, leafId)
    }
    leafIdByPtyIdByTabId.set(tabId, leafIdByPtyId)
    changed ||= normalized.changed
  }
  return {
    changed,
    leafIdByInputLeafIdByTabId,
    leafIdByPtyIdByTabId,
    // Alias replacement still requires callers to clear the legacy restart-required field.
    migrationUnsupportedEntries: [],
    legacyPaneKeyAliasEntries
  }
}

/** Hostless acknowledgement keys must keep their first tab mapping. */
