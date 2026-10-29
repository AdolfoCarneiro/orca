import { resolve as resolvePath } from 'node:path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../shared/cross-platform-path'
import { projectGroupIdFromRepoId } from '../shared/folder-workspace-worktree'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../shared/execution-host'
import { readOrchestrationCompatibilityEvidence } from '../shared/orchestration-compatibility-evidence'
import type { RuntimeWorktreeListResult, RuntimeWorktreeRecord } from '../shared/runtime-types'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'

type CatalogRow = Pick<RuntimeWorktreeRecord, 'id' | 'path' | 'hostId'> & {
  identity?: { key: string }
}

/** SSH relays stamp the caller host; otherwise use this machine. */
export function getCallerExecutionHostId(
  env: Readonly<Record<string, string | undefined>> = process.env
): ExecutionHostId {
  const host = readOrchestrationCompatibilityEvidence(env)?.host
  return host?.kind === 'ssh' ? toSshExecutionHostId(host.targetId) : LOCAL_EXECUTION_HOST_ID
}

// Paths may exist on multiple hosts; runtime:* and unstamped rows belong to this runtime.
function isOnCallerHost(row: CatalogRow, callerHostId: ExecutionHostId): boolean {
  const rowHostId = row.hostId ?? LOCAL_EXECUTION_HOST_ID
  return parseExecutionHostId(callerHostId)?.kind === 'ssh'
    ? rowHostId === callerHostId
    : parseExecutionHostId(rowHostId)?.kind !== 'ssh'
}

// Prefer id: for repo inference; shared IDs need an exact host-qualified identity.
function toHostScopedSelector(row: CatalogRow, catalog: readonly CatalogRow[]): string {
  const sharedId = catalog.some((other) => other !== row && other.id === row.id)
  return sharedId && row.identity?.key ? `identity:${row.identity.key}` : `id:${row.id}`
}

export type HostScopedWorktreeSelection = { selector: string; worktreeId: string }

/** Workspace ownership stays separate from project inference: siblings can share a checkout. */
export function selectEnclosingWorktreeSelectionOnHost(
  catalog: readonly CatalogRow[],
  cwd: string,
  hostId: ExecutionHostId,
  callerWorktreeId?: string
): HostScopedWorktreeSelection | undefined {
  const currentPath = resolvePath(cwd)
  let enclosing: CatalogRow | undefined
  let enclosingPathLength = -1
  for (const row of catalog) {
    if (!isOnCallerHost(row, hostId)) {
      continue
    }
    const rowPath = normalizeRuntimePathForComparison(resolvePath(row.path))
    if (!isPathInsideOrEqual(rowPath, currentPath)) {
      continue
    }
    // Folder workspaces share their project's path, so only the caller's pane can break the tie.
    if (
      rowPath.length < enclosingPathLength ||
      (rowPath.length === enclosingPathLength && row.id !== callerWorktreeId)
    ) {
      continue
    }
    enclosing = row
    enclosingPathLength = rowPath.length
  }
  return enclosing
    ? { selector: toHostScopedSelector(enclosing, catalog), worktreeId: enclosing.id }
    : undefined
}

export function selectEnclosingRepoOnHost(
  catalog: readonly (CatalogRow & Pick<RuntimeWorktreeRecord, 'repoId'>)[],
  cwd: string,
  hostId: ExecutionHostId,
  callerWorktreeId?: string
): string | undefined {
  const currentPath = resolvePath(cwd)
  const enclosing = catalog
    .filter(
      (row) =>
        !projectGroupIdFromRepoId(row.repoId) &&
        isOnCallerHost(row, hostId) &&
        isPathInsideOrEqual(resolvePath(row.path), currentPath)
    )
    .map((row) => ({ row, path: normalizeRuntimePathForComparison(resolvePath(row.path)) }))
  const innermostLength = Math.max(...enclosing.map(({ path }) => path.length))
  const candidates = enclosing.filter(({ path }) => path.length === innermostLength)
  const checkouts = new Map<string, (typeof catalog)[number]>()
  const callerCheckouts = new Set<string>()
  for (const { row, path } of candidates) {
    const key = JSON.stringify([row.repoId, row.hostId ?? LOCAL_EXECUTION_HOST_ID, path])
    checkouts.set(key, row)
    if (row.id === callerWorktreeId) {
      callerCheckouts.add(key)
    }
  }
  const matches = [...checkouts]
    .filter(([key]) => callerCheckouts.size === 0 || callerCheckouts.has(key))
    .map(([, row]) => row)
  if (matches.length > 1) {
    const projects = matches
      .map((row) => ({ repo: `id:${row.repoId}`, hostId: row.hostId, path: row.path }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    throw new RuntimeClientError(
      'selector_ambiguous',
      `More than one Orca project contains the current directory: ${currentPath}. Choose the project with --repo or --project.`,
      {
        projects,
        nextSteps: [
          'Run `orca repo list --json` or `orca project list --json`, then pass the intended --repo or --project selector.'
        ]
      }
    )
  }
  return matches[0]?.repoId
}

export function selectWorktreeCreateCwdContext(
  catalog: RuntimeWorktreeListResult['worktrees'],
  cwd: string,
  inferRepo: boolean
): { parentWorktree?: HostScopedWorktreeSelection; repoId?: string } {
  const hostId = getCallerExecutionHostId()
  const callerWorktreeId = process.env.ORCA_WORKTREE_ID
  return {
    repoId: inferRepo
      ? selectEnclosingRepoOnHost(catalog, cwd, hostId, callerWorktreeId)
      : undefined,
    parentWorktree: selectEnclosingWorktreeSelectionOnHost(catalog, cwd, hostId, callerWorktreeId)
  }
}

export function selectEnclosingWorktreeOnHost(
  catalog: readonly CatalogRow[],
  cwd: string,
  hostId: ExecutionHostId
): string | undefined {
  return selectEnclosingWorktreeSelectionOnHost(catalog, cwd, hostId)?.selector
}

export function selectWorktreeIdOnHost(
  catalog: readonly CatalogRow[],
  worktreeId: string,
  hostId: ExecutionHostId
): string | undefined {
  const match = catalog.find((row) => row.id === worktreeId && isOnCallerHost(row, hostId))
  return match ? toHostScopedSelector(match, catalog) : undefined
}

export async function resolveCallerPaneWorktreeSelector(
  worktreeId: string,
  client: RuntimeClient
): Promise<string | undefined> {
  const callerHostId = getCallerExecutionHostId()
  if (callerHostId === LOCAL_EXECUTION_HOST_ID) {
    return worktreeId
  }
  const worktrees = await client.call<RuntimeWorktreeListResult>('worktree.list', {
    limit: 10_000
  })
  return selectWorktreeIdOnHost(worktrees.result.worktrees, worktreeId, callerHostId)
}
