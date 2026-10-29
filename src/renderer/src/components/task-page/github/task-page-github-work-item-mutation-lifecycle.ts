import type { GitHubTaskObservation } from '@/lib/github-task-observation'

import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'

import type { ParsedTaskQuery } from '../../../../../shared/task-query'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import type { TaskSourceContext } from '../../../../../shared/task-source-context'

import {
  familiesFromPendingOp,
  getRegistryMergedTaskPageGitHubWorkItem,
  establishTaskPageGitHubMembership
} from './task-page-github-work-item-mutation-composition'

import {
  deletePendingTaskPageGitHubOp,
  getListEntry,
  listInput,
  confirmListOperation,
  completedListClaim,
  deleteConfirmedListSnapshot,
  getPendingTaskPageGitHubOp,
  listPendingTaskPageGitHubOpsForItem,
  notifyTaskPageGitHubMutationRegistry,
  setLastConfirmedClientValue,
  isTaskPageGitHubMutationQueryKeyCurrent
} from './task-page-github-work-item-mutation-registry'

import { markTaskPageGitHubFamiliesDirty } from './task-page-github-work-item-quiet-state'

import { taskPageGitHubOwnedItemKey } from './task-page-github-work-item-mutation-keys'

import type { TaskPageGitHubMutationKey } from './task-page-github-work-item-registry-types'

import type {
  CurrentListInputResolver,
  TaskPageGitHubPatchWorkItem
} from './task-page-github-work-item-mutation-types'

export function confirmTaskPageGitHubWorkItemMutation(
  key: TaskPageGitHubMutationKey,
  generation: number,
  opts: {
    currentObservation?: GitHubTaskObservation
    query: ParsedTaskQuery
    queryKey: string
    viewerLogin: string | null
    item: GitHubWorkItem
    resolveCurrentListInput?: CurrentListInputResolver
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
    const address = { ...key, family: listOp.family }
    const fallback = {
      ...opts.item,
      ...pending.previous,
      githubValueOrigins: pending.previousOrigins
    }
    confirmListOperation(
      key,
      generation,
      opts.resolveCurrentListInput?.(address, fallback) ??
        listInput(fallback, listOp.family, key.observation)
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
  const merged = getRegistryMergedTaskPageGitHubWorkItem(
    opts.item,
    key.sourceScope,
    key.observation
  )
  if (opts.patchWorkItem && listOp) {
    opts.patchWorkItem(opts.item.id, {}, key.repoId, {
      sourceContext: opts.sourceContext,
      ownerRepo:
        opts.item.type === 'issue' ? parseGitHubIssueOrPRLink(opts.item.url)?.slug : undefined,
      observation: key.observation,
      listComposition: [{ address: { ...key, family: listOp.family } }]
    })
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
  resolveCurrentListInput?: CurrentListInputResolver
}): 'rolled_back' | 'stale' {
  const pending = getPendingTaskPageGitHubOp(args.key)
  if (!pending || pending.generation !== args.generation) {
    return 'stale'
  }
  const { skipMeQualifiers, listOp } = pending
  deletePendingTaskPageGitHubOp(args.key)
  if (listOp) {
    const address = { ...args.key, family: listOp.family }
    const entry = getListEntry(address)
    const remaining = listPendingTaskPageGitHubOpsForItem(
      args.key.repoId,
      args.key.itemId,
      args.key.sourceScope,
      args.key.observation
    )
    const retired =
      entry &&
      !completedListClaim(entry) &&
      !remaining.some((op) => op.listOp?.family === listOp.family)
        ? entry
        : undefined
    const retirement =
      retired &&
      deleteConfirmedListSnapshot(
        address.sourceScope,
        address.repoId,
        address.itemId,
        address.family,
        address.observation,
        address.itemType
      )
    args.patchWorkItem(args.item.id, {}, args.key.repoId, {
      sourceContext: args.sourceContext,
      ownerRepo:
        args.item.type === 'issue' ? parseGitHubIssueOrPRLink(args.item.url)?.slug : undefined,
      observation: args.key.observation,
      listComposition: [{ address, retirement }]
    })
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
        valueOrigins: pending.previousOrigins
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
