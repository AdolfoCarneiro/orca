import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { dirname, join } from 'node:path'
import { getOrcaUserDataPath } from './codex-home-paths'
import { parseRegistry, isPaneAccountRecord } from './codex-pane-account-registry-types'
import { CodexPaneAccountRegistryMutations } from './codex-pane-account-registry-mutations'
import type {
  CodexPaneAccountRecord,
  CodexPaneAccountRegistryFile,
  CodexPaneHomeRoute,
  CodexPaneHomeObservation
} from './codex-pane-account-registry-types'

export type {
  CodexPaneAccountRecord,
  CodexPaneHomeRoute
} from './codex-pane-account-registry-types'

// Daemon PTYs retain spawn-time CODEX_HOME across app restarts; persist attribution for restart prompts.

let cachedRegistry: CodexPaneAccountRegistryFile | null = null
let cachedRegistryIsAuthoritative = true

function getRegistryPath(): string {
  return join(getOrcaUserDataPath(), 'codex-pane-accounts.json')
}

// Return uncached null on read errors; treating unreadable state as empty would erase attribution.
function readRegistryOrNull(): CodexPaneAccountRegistryFile | null {
  if (cachedRegistry) {
    return cachedRegistry
  }
  let rawRegistry: string
  try {
    rawRegistry = readFileSync(getRegistryPath(), 'utf-8')
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      return null
    }
    cachedRegistry = parseRegistry(null)
    return cachedRegistry
  }
  // Cache salvaged/corrupt parse results; rereading unchanged bytes cannot recover more state.
  const parsedRegistry = parseRegistryJson(rawRegistry)
  cachedRegistryIsAuthoritative = isAuthoritativeRegistry(parsedRegistry)
  cachedRegistry = parseRegistry(parsedRegistry)
  if (!cachedRegistryIsAuthoritative) {
    cachedRegistry.legacyWslAttributionUnknown = true
  }
  return cachedRegistry
}

function parseRegistryJson(rawRegistry: string): unknown {
  try {
    return JSON.parse(rawRegistry)
  } catch {
    return null
  }
}

// Callers may read pending mutations while the disk registry is unavailable.
function readRegistry(): CodexPaneAccountRegistryFile {
  mutations.flush()
  if (!cachedRegistry) {
    const pendingRegistry = mutations.getPendingRegistry()
    if (pendingRegistry) {
      return pendingRegistry
    }
  }
  return readRegistryOrNull() ?? { version: 2, panes: {} }
}

function readRegistryOrThrow(): CodexPaneAccountRegistryFile {
  mutations.flush()
  const registry = readRegistryOrNull()
  if (!registry || !cachedRegistryIsAuthoritative) {
    throw new Error('Codex pane account registry could not be read')
  }
  return registry
}

function isAuthoritativeRegistry(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false
  }
  const panes = (parsed as Partial<CodexPaneAccountRegistryFile>).panes
  const version = (parsed as Partial<CodexPaneAccountRegistryFile>).version
  const legacyWslAttributionUnknown = (parsed as Partial<CodexPaneAccountRegistryFile>)
    .legacyWslAttributionUnknown
  return (
    version === 2 &&
    Boolean(panes) &&
    typeof panes === 'object' &&
    !Array.isArray(panes) &&
    Object.values(panes).every(isPaneAccountRecord) &&
    (legacyWslAttributionUnknown === undefined || legacyWslAttributionUnknown === true)
  )
}

function writeRegistry(registry: CodexPaneAccountRegistryFile): boolean {
  const registryPath = getRegistryPath()
  const temporaryPath = `${registryPath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(registryPath), { recursive: true })
    writeFileSync(temporaryPath, `${JSON.stringify(registry)}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    })
    renameSync(temporaryPath, registryPath)
    cachedRegistryIsAuthoritative = true
    return true
  } catch (error) {
    // Restart-hint persistence failures must not break PTY spawn/teardown, including cleanup failures.
    console.warn('[codex-pane-accounts] Failed to persist pane account registry:', error)
    try {
      rmSync(temporaryPath, { force: true })
    } catch {}
    return false
  }
}

const mutations = new CodexPaneAccountRegistryMutations({
  read: readRegistryOrNull,
  write: writeRegistry
})

export function recordCodexPaneAccount(ptyId: string, record: CodexPaneAccountRecord | null): void {
  // Retain one-shot spawn attribution during read failures, then merge it into recovered state.
  mutations.record(ptyId, record)
}

export function forgetCodexPaneAccount(ptyId: string): void {
  observations.delete(ptyId)
  recordCodexPaneAccount(ptyId, null)
}

const observations = new Map<string, CodexPaneHomeObservation>()

export function observeCodexPaneHome(
  ptyId: string,
  observation: CodexPaneHomeObservation | null
): void {
  if (observation) {
    observations.set(ptyId, observation)
  } else {
    observations.delete(ptyId)
  }
}

export function getObservedCodexPaneHome(ptyId: string): CodexPaneHomeObservation | null {
  return observations.get(ptyId) ?? null
}

export function isCurrentCodexPaneObservation(
  ptyId: string,
  observation: CodexPaneHomeObservation
): boolean {
  return observations.get(ptyId) === observation
}

/** A saved receipt is qualified only by the current owning provider's actual incarnation. */
export function restoreCodexPaneHome(
  ptyId: string,
  incarnationId: string | undefined
): CodexPaneHomeObservation | null {
  const live = observations.get(ptyId)
  if (live) {
    return live.incarnationId === incarnationId ? live : null
  }
  const entry = readRegistry().panes[ptyId]
  const provenance = entry?.launchProvenance
  if (!provenance || provenance.incarnationId !== incarnationId) {
    return null
  }
  const observation = {
    actualHome: provenance.homePath,
    incarnationId,
    registration: {},
    frozenOrigin: { ...entry, selectionKey: entry.selectionKey ?? 'host' }
  }
  observations.set(ptyId, observation)
  return observation
}

export function dismissCodexPaneAccount(ptyId: string): void {
  const entry = readRegistry().panes[ptyId]
  if (!entry) {
    return
  }
  if (!entry.launchProvenance) {
    mutations.record(ptyId, null)
    return
  }
  const { selectionKey: _noticeLane, ...address } = entry
  mutations.record(ptyId, address)
}

export function getCodexPaneAccount(ptyId: string): CodexPaneAccountRecord | null {
  const entry = readRegistry().panes[ptyId]
  return entry?.selectionKey ? { ...entry, selectionKey: entry.selectionKey } : null
}

export function isCodexPaneHomeRouteProvenAwayFromSharedHome(
  route: CodexPaneHomeRoute | undefined
): boolean {
  return route === 'real-home' || route === 'account-home' || route === 'wsl-home'
}

// Use actual spawn lanes for account-switch prompts; edited settings no longer describe retained panes.
export function listRecordedCodexPaneLanes(ptyIds: readonly string[]): Record<string, string> {
  const registry = readRegistryOrThrow()
  const lanesByPtyId: Record<string, string> = {}
  for (const ptyId of ptyIds) {
    const record = registry.panes[ptyId]
    if (record?.selectionKey) {
      lanesByPtyId[ptyId] = record.selectionKey
    }
  }
  return lanesByPtyId
}

/** Restart decisions require authoritative attribution, not an unavailable-file fallback. */
export function listRecordedCodexPaneAccounts(
  ptyIds: readonly string[]
): ReadonlyMap<string, CodexPaneAccountRecord> {
  const registry = readRegistryOrThrow()
  const records = new Map<string, CodexPaneAccountRecord>()
  for (const ptyId of ptyIds) {
    const record = registry.panes[ptyId]
    if (record?.selectionKey) {
      records.set(ptyId, { ...record, selectionKey: record.selectionKey })
    }
  }
  return records
}

export function hasRecordedLegacySharedCodexPane(): boolean {
  return Object.values(readRegistry().panes).some(
    (record) =>
      record.selectionKey === 'host' &&
      (record.homeRoute === undefined || record.homeRoute === 'shared-home')
  )
}

export function hasRecordedLegacyWslCodexPane(selectionKey: string): boolean {
  const registry = readRegistryOrThrow()
  return (
    Boolean(registry.legacyWslAttributionUnknown) ||
    Object.values(registry.panes).some(
      (record) =>
        (wslSelectionKeysMatch(record.selectionKey ?? '', selectionKey) ||
          record.selectionKey === 'wsl:__default__') &&
        (record.homeRoute === undefined || record.homeRoute === 'wsl-home')
    )
  )
}

function wslSelectionKeysMatch(left: string, right: string): boolean {
  return (
    left.startsWith('wsl:') &&
    right.startsWith('wsl:') &&
    left.slice('wsl:'.length).toLowerCase() === right.slice('wsl:'.length).toLowerCase()
  )
}

export function hasAnyRecordedLegacyWslCodexPane(): boolean {
  const registry = readRegistry()
  return (
    Boolean(registry.legacyWslAttributionUnknown) ||
    Object.values(registry.panes).some(
      (record) =>
        record.selectionKey?.startsWith('wsl:') &&
        (record.homeRoute === undefined || record.homeRoute === 'wsl-home')
    )
  )
}

export function hasRecordedManagedHostCodexPane(): boolean {
  return Object.values(readRegistry().panes).some(
    (record) =>
      record.selectionKey === 'host' &&
      (record.homeRoute === undefined ||
        record.homeRoute === 'shared-home' ||
        (record.homeRoute === 'account-home' && record.accountId !== null))
  )
}

/** Capture before an asynchronous authoritative census; a later birth must survive its result. */
export function captureCodexPaneAccountInventory() {
  return { entries: { ...readRegistry().panes }, observations: new Map(observations) }
}

/** livePtyIds must cover the entire sampled local daemon population, never a partial reply. */
export function reconcileCodexPaneAccountsWithLivePtys(
  livePtyIds: readonly string[],
  sampled = captureCodexPaneAccountInventory()
): void {
  const live = new Set(livePtyIds)
  const registry = readRegistryOrNull()
  for (const [id, entry] of Object.entries(sampled.entries)) {
    if (
      !live.has(id) &&
      registry?.panes[id] === entry &&
      observations.get(id) === sampled.observations.get(id)
    ) {
      forgetCodexPaneAccount(id)
    }
  }
  if (registry?.legacyWslAttributionUnknown && livePtyIds.every((id) => id in registry.panes)) {
    delete registry.legacyWslAttributionUnknown
    mutations.persistReconciliation(registry, true)
  }
}

export const _internals = {
  resetProcess: (): void => {
    observations.clear()
    cachedRegistry = null
    cachedRegistryIsAuthoritative = true
    mutations.reset()
  },
  resetCache: (): void => {
    cachedRegistry = null
    cachedRegistryIsAuthoritative = true
  }
}
