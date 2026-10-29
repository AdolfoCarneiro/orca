import type { GitHubTaskObservation } from '@/lib/github-task-observation'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { applyTaskPageGitHubListOps } from './task-page-github-work-item-mutation-patches'
import {
  familiesFromPendingOp,
  freezeTaskPageGitHubUsers,
  getRegistryMergedTaskPageGitHubWorkItem,
  establishTaskPageGitHubMembership
} from './task-page-github-work-item-mutation-composition'
import {
  deletePendingTaskPageGitHubOp,
  getConfirmedListSnapshot,
  getPendingTaskPageGitHubOp,
  listPendingTaskPageGitHubOpsForItem,
  notifyTaskPageGitHubMutationRegistry,
  setConfirmedListSnapshot,
  setLastConfirmedClientValue,
  isTaskPageGitHubMutationQueryKeyCurrent
} from './task-page-github-work-item-mutation-registry'
import { markTaskPageGitHubFamiliesDirty } from './task-page-github-work-item-quiet-state'
import { taskPageGitHubOwnedItemKey } from './task-page-github-work-item-mutation-keys'
import type { TaskPageGitHubMutationKey } from './task-page-github-work-item-registry-types'
import type { TaskPageGitHubPatchWorkItem } from './task-page-github-work-item-mutation-types'

export function confirmTaskPageGitHubWorkItemMutation(
  key: TaskPageGitHubMutationKey,
  generation: number,
  opts: {
    currentObservation?: GitHubTaskObservation
    query: ParsedTaskQuery
    queryKey: string
    viewerLogin: string | null
    item: GitHubWorkItem
    serverEntity?: Partial<GitHubWorkItem>
    patchWorkItem?: TaskPageGitHubPatchWorkItem
    sourceContext?: TaskSourceContext | null
    scheduleQuiet?: boolean
  }
): 'confirmed' | 'stale' {
  const pending = getPendingTaskPageGitHubOp(key)
  if (!pending || pending.generation !== generation) {
    return 'stale'
  }
  const { skipMeQualifiers, listOp, next } = pending
  if (listOp) {
    const snapshot =
      getConfirmedListSnapshot(
        key.sourceScope,
        key.repoId,
        key.itemId,
        listOp.family,
        key.observation,
        key.itemType
      ) ??
      freezeTaskPageGitHubUsers(
        listOp.family === 'assignees'
          ? (opts.item.assignees ?? [])
          : (opts.item.reviewRequests ?? [])
      )
    // Confirm list ops into snapshots immediately; lastConfirmedClientValue stores scalar authority only.
    const applied = applyTaskPageGitHubListOps(snapshot, [listOp])
    setConfirmedListSnapshot(
      key.sourceScope,
      key.repoId,
      key.itemId,
      listOp.family,
      applied,
      key.observation,
      key.itemType
    )
  } else {
    if (next.state !== undefined) {
      setLastConfirmedClientValue(
        key.sourceScope,
        key.repoId,
        opts.item.id,
        'state',
        next.state,
        undefined,
        key.observation
      )
    }
    if (next.autoMergeEnabled !== undefined) {
      setLastConfirmedClientValue(
        key.sourceScope,
        key.repoId,
        opts.item.id,
        'autoMerge',
        next.autoMergeEnabled,
        undefined,
        key.observation
      )
    }
  }
  deletePendingTaskPageGitHubOp(key)
  applyServerEntityIfPresent(key, opts)
  const remaining = listPendingTaskPageGitHubOpsForItem(
    key.repoId,
    key.itemId,
    key.sourceScope,
    key.observation
  )
  const merged = getRegistryMergedTaskPageGitHubWorkItem(
    opts.item,
    key.sourceScope,
    key.observation
  )
  if (opts.patchWorkItem && remaining.some((op) => op.listOp)) {
    opts.patchWorkItem(
      opts.item.id,
      { assignees: merged.assignees, reviewRequests: merged.reviewRequests },
      key.repoId,
      {
        sourceContext: opts.sourceContext,
        ownerRepo:
          opts.item.type === 'issue' ? parseGitHubIssueOrPRLink(opts.item.url)?.slug : undefined,
        observation: key.observation,
        valueOrigins: merged.githubValueOrigins
      }
    )
  }
  if (
    isTaskPageGitHubMutationQueryKeyCurrent(opts.queryKey) &&
    key.observation?.key === opts.currentObservation?.key
  ) {
    establishTaskPageGitHubMembership({
      item: { ...opts.item, ...merged },
      sourceScope: key.sourceScope,
      queryKey: opts.queryKey,
      skipMeQualifiers,
      observation: key.observation
    })
  }
  if (
    isTaskPageGitHubMutationQueryKeyCurrent(opts.queryKey) &&
    key.observation?.key === opts.currentObservation?.key
  ) {
    markTaskPageGitHubFamiliesDirty(
      opts.queryKey,
      taskPageGitHubOwnedItemKey(
        key.sourceScope,
        key.repoId,
        pending.listOp ? key.itemId : opts.item.id,
        key.observation?.key
      ),
      familiesFromPendingOp(pending)
    )
  }
  notifyTaskPageGitHubMutationRegistry()
  return 'confirmed'
}
export function rollbackTaskPageGitHubWorkItemMutation(args: {
  key: TaskPageGitHubMutationKey
  generation: number
  patchWorkItem: TaskPageGitHubPatchWorkItem
  sourceContext?: TaskSourceContext | null
  currentObservation?: GitHubTaskObservation
  query: ParsedTaskQuery
  queryKey: string
  viewerLogin: string | null
  item: GitHubWorkItem
}): 'rolled_back' | 'stale' {
  const pending = getPendingTaskPageGitHubOp(args.key)
  if (!pending || pending.generation !== args.generation) {
    return 'stale'
  }
  const { skipMeQualifiers, listOp } = pending
  deletePendingTaskPageGitHubOp(args.key)
  const merged = getRegistryMergedTaskPageGitHubWorkItem(
    args.item,
    args.key.sourceScope,
    args.key.observation
  )
  if (listOp) {
    args.patchWorkItem(
      args.item.id,
      listOp.family === 'assignees'
        ? { assignees: merged.assignees }
        : { reviewRequests: merged.reviewRequests },
      args.key.repoId,
      {
        sourceContext: args.sourceContext,
        ownerRepo:
          args.item.type === 'issue' ? parseGitHubIssueOrPRLink(args.item.url)?.slug : undefined,
        observation: args.key.observation,
        valueOrigins: listOp ? merged.githubValueOrigins : pending.previousOrigins
      }
    )
  } else {
    const recomposed = getRegistryMergedTaskPageGitHubWorkItem(
      { ...args.item, ...pending.previous },
      args.key.sourceScope,
      args.key.observation
    )
    args.patchWorkItem(
      args.item.id,
      {
        state: recomposed.state,
        autoMergeEnabled: recomposed.autoMergeEnabled
      },
      args.key.repoId,
      {
        sourceContext: args.sourceContext,
        ownerRepo:
          args.item.type === 'issue' ? parseGitHubIssueOrPRLink(args.item.url)?.slug : undefined,
        observation: args.key.observation,
        valueOrigins: listOp ? merged.githubValueOrigins : pending.previousOrigins
      }
    )
  }
  const after = getRegistryMergedTaskPageGitHubWorkItem(
    args.item,
    args.key.sourceScope,
    args.key.observation
  )
  if (
    isTaskPageGitHubMutationQueryKeyCurrent(args.queryKey) &&
    args.key.observation?.key === args.currentObservation?.key
  ) {
    establishTaskPageGitHubMembership({
      item: { ...args.item, ...after },
      sourceScope: args.key.sourceScope,
      queryKey: args.queryKey,
      skipMeQualifiers,
      observation: args.key.observation
    })
  }
  notifyTaskPageGitHubMutationRegistry()
  return 'rolled_back'
}

import { applyServerEntityIfPresent } from './task-page-github-work-item-server-entity'
