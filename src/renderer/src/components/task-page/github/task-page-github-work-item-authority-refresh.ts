import type { GitHubTaskObservation } from '@/lib/github-task-observation'
import {
  taskPageGitHubFamilyDirtyKey,
  taskPageGitHubOwnedItemKey
} from './task-page-github-work-item-mutation-keys'
import {
  clearConfirmedAuthorityForItem,
  deleteConfirmedListSnapshot,
  getTaskPageGitHubConfirmedAuthorities,
  batchTaskPageGitHubMutationRegistry,
  getTaskPageGitHubPendingOwnerKeys,
  notifyTaskPageGitHubMutationRegistry
} from './task-page-github-work-item-mutation-registry'
import {
  deleteLastConfirmedClientValue,
  getLastConfirmedClientEntry
} from './task-page-github-confirmed-client-values'
import { getQuietRevalidateState } from './task-page-github-work-item-quiet-state'
import { MAX_LAG_TRAILS } from './task-page-github-work-item-quiet-adopt'

function clearTaskPageGitHubAuthorityAbsentFromLoadedItemsNow(
  loadedItemKeys: ReadonlySet<string>,
  owns?: (owner: GitHubTaskObservation | undefined) => boolean
): void {
  const pendingKeys = getTaskPageGitHubPendingOwnerKeys()
  let changed = false
  for (const record of getTaskPageGitHubConfirmedAuthorities()) {
    const { sourceScope, repoId, itemId, observation, itemType } = record
    if (owns && !owns(observation)) {
      continue
    }
    if (
      loadedItemKeys.has(
        taskPageGitHubOwnedItemKey(sourceScope, repoId, itemId, observation?.key)
      ) ||
      pendingKeys.has(taskPageGitHubOwnedItemKey(sourceScope, repoId, itemId, observation?.key))
    ) {
      continue
    }
    clearConfirmedAuthorityForItem(repoId, itemId, sourceScope, observation, itemType)
    changed = true
  }
  if (changed) {
    notifyTaskPageGitHubMutationRegistry()
  }
}
export function getTaskPageGitHubRevalidatableAuthorityItemKeys(
  queryKey: string
): ReadonlySet<string> {
  const keys = new Set<string>()
  const quiet = getQuietRevalidateState(queryKey)
  for (const record of getTaskPageGitHubConfirmedAuthorities()) {
    const key = taskPageGitHubOwnedItemKey(
      record.sourceScope,
      record.repoId,
      record.itemId,
      record.observation?.key
    )
    if (
      record.families.some(
        (family) =>
          (quiet?.lagSkipAttempts.get(taskPageGitHubFamilyDirtyKey(key, family)) ?? 0) <
          MAX_LAG_TRAILS
      )
    ) {
      keys.add(key)
    }
  }
  return keys
}
function clearTaskPageGitHubAuthorityThroughGenerationNow(
  queryKey: string,
  generation: number,
  owns?: (owner: GitHubTaskObservation | undefined) => boolean
): void {
  const quiet = getQuietRevalidateState(queryKey)
  for (const {
    sourceScope,
    repoId,
    itemId,
    observation,
    itemType,
    families
  } of getTaskPageGitHubConfirmedAuthorities()) {
    if (owns && !owns(observation)) {
      continue
    }
    const key = taskPageGitHubOwnedItemKey(sourceScope, repoId, itemId, observation?.key)
    for (const family of families) {
      if ((quiet?.familyDirtyAt.get(taskPageGitHubFamilyDirtyKey(key, family)) ?? 0) > generation) {
        continue
      }
      if (family === 'assignees' || family === 'reviewRequests') {
        deleteConfirmedListSnapshot(sourceScope, repoId, itemId, family, observation, itemType)
      } else if (
        getLastConfirmedClientEntry(sourceScope, repoId, itemId, family)?.observation?.key ===
        observation?.key
      ) {
        deleteLastConfirmedClientValue(sourceScope, repoId, itemId, family)
      }
    }
  }
  notifyTaskPageGitHubMutationRegistry()
}

export function clearTaskPageGitHubAuthorityAbsentFromLoadedItems(
  ...args: Parameters<typeof clearTaskPageGitHubAuthorityAbsentFromLoadedItemsNow>
): void {
  batchTaskPageGitHubMutationRegistry(() =>
    clearTaskPageGitHubAuthorityAbsentFromLoadedItemsNow(...args)
  )
}
export function clearTaskPageGitHubAuthorityThroughGeneration(
  ...args: Parameters<typeof clearTaskPageGitHubAuthorityThroughGenerationNow>
): void {
  batchTaskPageGitHubMutationRegistry(() =>
    clearTaskPageGitHubAuthorityThroughGenerationNow(...args)
  )
}
