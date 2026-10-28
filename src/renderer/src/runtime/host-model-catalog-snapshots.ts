import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { authorityKey, parseHostAuthorityKey } from '../../../shared/host-authority'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { getRuntimeTargetHostId, runtimeRpcTargetForAuthorityKey } from './runtime-client-target'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

/** Host/agent saved model lists seed new-chat pickers without a first-frame guess. Only host answers populate entries; newer answers replace them, absence/account-setting changes drop them. */

type ListedCatalog = Exclude<AgentSessionModelCatalogResult, { origin: 'unknown' }>

type AgentSnapshots = {
  /** A session-less read's answer: the account a new chat would pin, with no workspace named. */
  account: ListedCatalog | null
  /** A new chat's answer per worktree (`''` when it named none): only it says whether that
   *  workspace's own config replaces the listed default. */
  byWorktree: Map<string, ListedCatalog>
}

const snapshots = new Map<string, AgentSnapshots>()
const workspaceWriteOwners = new Map<string, Map<string, object>>()
const hostWriteOwners = new Map<string, object>()

function hostWriteOwner(hostKey: string): object {
  const owner = hostWriteOwners.get(hostKey) ?? {}
  hostWriteOwners.set(hostKey, owner)
  return owner
}

function snapshotKey(hostKey: string, agent: string): string {
  return `${hostKey}\u0000${agent}`
}

function withoutNamedDefault(catalog: ListedCatalog): ListedCatalog {
  return {
    ...catalog,
    models: catalog.models.map((model) => ({ ...model, isDefault: false })),
    listingNamesConfiguredModel: false
  }
}

/** Undefined until host answers for this frame. Workspace config can replace defaults, so another workspace’s answer is valid only for named models, no-default lists or host-proven workspace-independent defaults. */
export function readHostModelCatalogSnapshot(
  target: RuntimeClientTarget,
  agent: string,
  launch: { newLaunch: boolean; worktree?: string; seedsModel: boolean }
): AgentSessionModelCatalogResult | undefined {
  const entry = snapshots.get(snapshotKey(getRuntimeTargetHostId(target), agent))
  if (!entry) {
    return undefined
  }
  const exact = entry.byWorktree.get(launch.worktree ?? '')
  if (exact) {
    return exact
  }
  const listed = entry.account ?? entry.byWorktree.values().next().value
  if (!listed || listed.modelsDifferByWorkspace) {
    return undefined
  }
  if (
    !launch.newLaunch ||
    listed.listingNamesConfiguredModel === false ||
    listed.defaultHoldsInEveryWorkspace === true
  ) {
    return listed
  }
  return launch.seedsModel ? withoutNamedDefault(listed) : undefined
}

/** Keeps a host answer for the account a new chat pins; `worktree` null for a session-less read. */
export function recordHostModelCatalogSnapshot(
  target: RuntimeClientTarget,
  agent: string,
  worktree: string | null,
  catalog: AgentSessionModelCatalogResult
): void {
  const key = snapshotKey(getRuntimeTargetHostId(target), agent)
  if (catalog.origin === 'unknown' || catalog.models.length === 0) {
    // The account a new chat pins has no list: an older answer belongs to another account.
    snapshots.delete(key)
    return
  }
  const entry = snapshots.get(key) ?? { account: null, byWorktree: new Map() }
  if (worktree === null) {
    // A newer account-level list supersedes per-workspace answers made from an older one.
    snapshots.set(key, { account: catalog, byWorktree: new Map() })
    return
  }
  entry.byWorktree.set(worktree, catalog)
  // A default no workspace can replace is every new chat's, wherever it runs.
  snapshots.set(
    key,
    catalog.defaultHoldsInEveryWorkspace === true ? { ...entry, account: catalog } : entry
  )
}

/** A reply may seed future chats only while its workspace still has the same owner. */
export function hostModelCatalogSnapshotWriter(
  target: RuntimeClientTarget,
  agent: string,
  worktree: string
): (catalog: AgentSessionModelCatalogResult) => void {
  const hostKey = getRuntimeTargetHostId(target)
  const hostOwner = hostWriteOwner(hostKey)
  const owners = workspaceWriteOwners.get(hostKey) ?? new Map<string, object>()
  const owner = owners.get(worktree) ?? {}
  owners.set(worktree, owner)
  workspaceWriteOwners.set(hostKey, owners)
  return (catalog) => {
    if (
      workspaceWriteOwners.get(hostKey)?.get(worktree) === owner &&
      hostWriteOwners.get(hostKey) === hostOwner
    ) {
      recordHostModelCatalogSnapshot(target, agent, worktree, catalog)
    }
  }
}

export function forgetHostModelCatalogSnapshotsForWorkspaces(
  executionHostId: string | undefined,
  worktreeIds: Iterable<string>
): void {
  const authority = parseHostAuthorityKey(executionHostId)
  const target = authority ? runtimeRpcTargetForAuthorityKey(authorityKey(authority)) : null
  if (!target) {
    return
  }
  const hostKey = getRuntimeTargetHostId(target)
  const selectors = new Set(Array.from(worktreeIds, toRuntimeWorktreeSelector))
  if (selectors.size === 0) {
    return
  }
  const owners = workspaceWriteOwners.get(hostKey)
  for (const selector of selectors) {
    owners?.delete(selector)
  }
  if (owners?.size === 0) {
    workspaceWriteOwners.delete(hostKey)
  }
  const prefix = `${hostKey}\u0000`
  for (const [key, entry] of snapshots) {
    if (!key.startsWith(prefix)) {
      continue
    }
    for (const selector of selectors) {
      entry.byWorktree.delete(selector)
    }
    if (entry.account === null && entry.byWorktree.size === 0) {
      snapshots.delete(key)
    }
  }
}

/** Drop all or selected agents’ host answers when the account a new chat pins may change. */
export function forgetHostModelCatalogSnapshots(
  target: RuntimeClientTarget,
  agents?: readonly string[]
): void {
  const hostKey = getRuntimeTargetHostId(target)
  hostWriteOwners.delete(hostKey)
  if (!agents) {
    workspaceWriteOwners.delete(hostKey)
  }
  for (const key of snapshots.keys()) {
    const [keyHost, keyAgent] = key.split('\u0000')
    if (keyHost === hostKey && (!agents || agents.includes(keyAgent ?? ''))) {
      snapshots.delete(key)
    }
  }
}

/** The agents a host has answered for, so a reconnect can read them again. */
export function hostModelCatalogSnapshotAgents(target: RuntimeClientTarget): string[] {
  const prefix = `${getRuntimeTargetHostId(target)}\u0000`
  return [...snapshots.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
}

/** Preload account-level lists per agent; failed reads prove no absence. Send savedOnly only when host advertises it, avoiding unsaved CLI listing. */
export async function preloadHostModelCatalogSnapshots(
  target: RuntimeClientTarget,
  agents: readonly string[],
  options: { savedOnly?: true } = {}
): Promise<void> {
  const hostKey = getRuntimeTargetHostId(target)
  const hostOwner = hostWriteOwner(hostKey)
  const { callStructuredAgentSession } = await import('./structured-agent-session-client')
  if (hostWriteOwners.get(hostKey) !== hostOwner) {
    return
  }
  await Promise.all(
    agents.map((agent) =>
      callStructuredAgentSession<AgentSessionModelCatalogResult>(
        target,
        'agentSession.modelCatalog',
        { agent, ...options }
      )
        .then((catalog) => {
          if (hostWriteOwners.get(hostKey) === hostOwner) {
            recordHostModelCatalogSnapshot(target, agent, null, catalog)
          }
        })
        .catch(() => undefined)
    )
  )
}

export function resetHostModelCatalogSnapshotsForTests(): void {
  snapshots.clear()
  workspaceWriteOwners.clear()
  hostWriteOwners.clear()
}
