import { createTaskPageGitHubScalarAuthorityIndex } from './task-page-github-confirmed-client-values'
import { createTaskPageGitHubAuthorityProjection } from './task-page-github-work-item-mutation-composition'
import {
  taskPageGitHubAuthorityItemKeys,
  taskPageGitHubOwnedItemKey,
  taskPageGitHubFamilyDirtyKey
} from './task-page-github-work-item-mutation-keys'
import { getGitHubTaskObservation } from '@/lib/github-task-observation'
import { githubTaskSourceKey } from '@/lib/github-task-target'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import {
  adoptQuietSearchFieldsForItem,
  MAX_LAG_TRAILS
} from './task-page-github-work-item-quiet-adopt'
import {
  clearConfirmedAuthorityForItem,
  getTaskPageGitHubConfirmedAuthorities,
  getTaskPageGitHubPendingEntries,
  getTaskPageGitHubMembershipBases,
  deleteTaskPageGitHubMembershipBasis,
  batchTaskPageGitHubMutationRegistry,
  getTaskPageGitHubPendingOwnerKeys,
  notifyTaskPageGitHubMutationRegistry
} from './task-page-github-work-item-mutation-registry'
import { getOrCreateQuietRevalidateState } from './task-page-github-work-item-quiet-state'
import type { GitHubWorkItemPatch } from '@/store/github/cache-model'

export type TaskPageQuietRevalidateScope = { queryKey: string; generation: number }

export function advanceTaskPageQuietRevalidateScope(
  scope: TaskPageQuietRevalidateScope,
  queryKey: string
): TaskPageQuietRevalidateScope {
  return scope.queryKey === queryKey ? scope : { queryKey, generation: scope.generation + 1 }
}

export function isTaskPageQuietRevalidateScopeCurrent(
  scope: TaskPageQuietRevalidateScope,
  queryKey: string,
  generation: number
): boolean {
  return scope.queryKey === queryKey && scope.generation === generation
}

export function isTaskPageQuietRevalidateRunCurrent(
  scope: TaskPageQuietRevalidateScope,
  queryKey: string,
  generation: number,
  capturedRefreshEpoch: number,
  currentRefreshEpoch: number
): boolean {
  return (
    isTaskPageQuietRevalidateScopeCurrent(scope, queryKey, generation) &&
    capturedRefreshEpoch === currentRefreshEpoch
  )
}

export function getTaskPageQuietRevalidateBackoffAttempt(attempts: Iterable<number>): number {
  const eligible = [...attempts].filter((attempt) => attempt < MAX_LAG_TRAILS)
  return eligible.length === 0 ? 0 : Math.max(...eligible)
}

function settleQuietSearchRevalidateNow(args: {
  queryKey: string
  networkItems: readonly GitHubWorkItem[]
  fetchStartedAtGeneration: number
  patchWorkItems: (patches: readonly GitHubWorkItemPatch[]) => void
  revalidatedItemKeys?: ReadonlySet<string>
}): { needTrailing: boolean } {
  const patches: GitHubWorkItemPatch[] = []
  let needTrailing = false
  const scalarFor = createTaskPageGitHubScalarAuthorityIndex()
  const projection = createTaskPageGitHubAuthorityProjection()
  const pageKeys = new Set(args.networkItems.flatMap(taskPageGitHubAuthorityItemKeys))
  for (const serverItem of args.networkItems) {
    const observation = getGitHubTaskObservation(serverItem)
    const result = adoptQuietSearchFieldsForItem({
      scalarFor,
      projection,
      item: serverItem,
      serverItem,
      sourceScope: observation ? githubTaskSourceKey(observation.source) : null,
      observation,
      queryKey: args.queryKey,
      fetchStartedAtGeneration: args.fetchStartedAtGeneration,
      patchWorkItem: (itemId, patch, repoId, options) => {
        patches.push({ itemId, patch, repoId: repoId ?? serverItem.repoId, options })
      },
      sourceContext: observation?.source
    })
    needTrailing ||= result.needTrailing
  }
  const pendingKeys = getTaskPageGitHubPendingOwnerKeys()
  const safeKeys = new Set(pageKeys)
  for (const record of getTaskPageGitHubConfirmedAuthorities()) {
    const { sourceScope, repoId, itemId, observation, itemType } = record
    const key = taskPageGitHubOwnedItemKey(sourceScope, repoId, itemId, observation?.key)
    if (!pageKeys.has(key) && args.revalidatedItemKeys?.has(key) && !pendingKeys.has(key)) {
      clearConfirmedAuthorityForItem(repoId, itemId, sourceScope, observation, itemType)
    } else {
      safeKeys.add(key)
    }
  }
  for (const op of getTaskPageGitHubPendingEntries().values()) {
    safeKeys.add(
      taskPageGitHubOwnedItemKey(
        op.key.sourceScope,
        op.key.repoId,
        op.key.itemId,
        op.key.observation?.key
      )
    )
  }
  const safeLagKeys = new Set<string>()
  for (const key of safeKeys) {
    for (const family of ['state', 'autoMerge', 'assignees', 'reviewRequests']) {
      safeLagKeys.add(taskPageGitHubFamilyDirtyKey(key, family))
    }
  }
  for (const [key, basis] of getTaskPageGitHubMembershipBases()) {
    const ownerKey = taskPageGitHubOwnedItemKey(
      basis.sourceScope,
      basis.repoId,
      basis.itemId,
      basis.observation?.key
    )
    if (
      basis.queryKey === args.queryKey &&
      args.revalidatedItemKeys?.has(ownerKey) &&
      !safeKeys.has(ownerKey)
    ) {
      deleteTaskPageGitHubMembershipBasis(key)
    }
  }
  const quiet = getOrCreateQuietRevalidateState(args.queryKey)
  for (const key of quiet.lagSkipAttempts.keys()) {
    if (!safeLagKeys.has(key)) {
      quiet.lagSkipAttempts.delete(key)
    }
  }
  if (quiet.dirtyGeneration > args.fetchStartedAtGeneration) {
    needTrailing = true
  }
  args.patchWorkItems(patches)
  notifyTaskPageGitHubMutationRegistry()
  return { needTrailing }
}
export function processTaskPageQuietRevalidateSettle(
  args: Omit<Parameters<typeof settleQuietSearchRevalidate>[0], 'fetchStartedAtGeneration'>
): { needTrailing: boolean } {
  const state = getOrCreateQuietRevalidateState(args.queryKey)
  return settleQuietSearchRevalidate({
    ...args,
    fetchStartedAtGeneration: state.fetchStartedAtGeneration
  })
}

export function settleQuietSearchRevalidate(
  ...args: Parameters<typeof settleQuietSearchRevalidateNow>
): ReturnType<typeof settleQuietSearchRevalidateNow> {
  return batchTaskPageGitHubMutationRegistry(() => settleQuietSearchRevalidateNow(...args))
}
