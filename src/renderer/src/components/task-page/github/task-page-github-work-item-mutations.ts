import { getGitHubTaskObservation, type GitHubTaskObservation } from '@/lib/github-task-observation'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import { taskPageGitHubMutationItemId } from './task-page-github-work-item-mutation-keys'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import {
  buildTaskPageGitHubWorkItemMutationPatch,
  type TaskPageGitHubMutationIntent
} from './task-page-github-work-item-mutation-patches'
import {
  createTaskPageGitHubAuthorityProjection,
  familiesFromPendingOp,
  getRegistryMergedTaskPageGitHubWorkItem,
  establishTaskPageGitHubMembership,
  stripFamilyPendingFromList
} from './task-page-github-work-item-mutation-composition'
import {
  getConfirmedListSnapshot,
  getPendingTaskPageGitHubOp,
  listPendingTaskPageGitHubOpsForItem,
  nextTaskPageGitHubMutationGeneration,
  notifyTaskPageGitHubMutationRegistry,
  setConfirmedListSnapshot,
  setPendingTaskPageGitHubOp,
  setTaskPageGitHubMutationQueryKey
} from './task-page-github-work-item-mutation-registry'
import { taskPageGitHubItemKey } from './task-page-github-work-item-mutation-keys'
import type {
  PendingOp,
  TaskPageGitHubMutationKey
} from './task-page-github-work-item-registry-types'
import type {
  BeginTaskPageGitHubWorkItemMutationArgs,
  BeginTaskPageGitHubWorkItemMutationResult
} from './task-page-github-work-item-mutation-types'

function resolveSourceScope(sourceContext?: TaskSourceContext | null): string | null {
  if (sourceContext?.provider === 'github') {
    return getTaskSourceCacheScope(sourceContext)
  }
  return null
}

function resolveTaskPageGitHubMutation(args: {
  item: GitHubWorkItem
  observation?: GitHubTaskObservation
  projection?: ReturnType<typeof createTaskPageGitHubAuthorityProjection>
  intent: TaskPageGitHubMutationIntent
  sourceContext?: TaskSourceContext | null
}) {
  const sourceScope = resolveSourceScope(args.sourceContext)
  const projection = args.projection ?? createTaskPageGitHubAuthorityProjection()
  const base = projection(args.item, sourceScope, args.observation)
  return {
    sourceScope,
    projection,
    built: buildTaskPageGitHubWorkItemMutationPatch(base, args.intent)
  }
}

export function canStartTaskPageGitHubWorkItemMutation(args: {
  item: GitHubWorkItem
  observation?: GitHubTaskObservation
  projection?: ReturnType<typeof createTaskPageGitHubAuthorityProjection>
  intent: TaskPageGitHubMutationIntent
  sourceContext?: TaskSourceContext | null
}): boolean {
  const { sourceScope, built, projection } = resolveTaskPageGitHubMutation(args)
  const itemId = taskPageGitHubMutationItemId(args.item)
  const key = {
    sourceScope,
    observation: args.observation ?? getGitHubTaskObservation(args.item),
    repoId: args.item.repoId,
    itemId,
    itemType: args.item.type,
    opKey: built.opKey
  }
  if (isTaskPageGitHubMutationPendingKey(key)) {
    return false
  }
  const pending = projection.pending(args.item, sourceScope, args.observation)
  if (built.kind === 'list') {
    const affectedLogins = new Set(built.listOp.logins)
    return !pending.some(
      (op) =>
        op.listOp?.family === built.family &&
        op.listOp.logins.some((login) => affectedLogins.has(login))
    )
  }
  return !pending.some(
    (op) =>
      !op.listOp && familiesFromPendingOp(op).some((family) => built.families.includes(family))
  )
}

export function beginTaskPageGitHubWorkItemMutation(
  args: BeginTaskPageGitHubWorkItemMutationArgs
): BeginTaskPageGitHubWorkItemMutationResult {
  setTaskPageGitHubMutationQueryKey(args.queryKey)
  const { sourceScope, built } = resolveTaskPageGitHubMutation(args)
  const itemId = taskPageGitHubMutationItemId(args.item)
  const skipMeQualifiers = args.skipMeQualifiers ?? false
  const key = {
    sourceScope,
    observation: args.observation ?? getGitHubTaskObservation(args.item),
    repoId: args.item.repoId,
    itemId,
    itemType: args.item.type,
    opKey: built.opKey
  }
  const generation = nextTaskPageGitHubMutationGeneration(key)

  if (built.kind === 'list') {
    const existing = getConfirmedListSnapshot(
      sourceScope,
      args.item.repoId,
      itemId,
      built.family,
      args.observation,
      args.item.type
    )
    if (!existing) {
      const ops = listPendingTaskPageGitHubOpsForItem(
        args.item.repoId,
        itemId,
        sourceScope,
        args.observation
      )
      const snapshot = stripFamilyPendingFromList(args.item, built.family, ops)
      setConfirmedListSnapshot(
        sourceScope,
        args.item.repoId,
        itemId,
        built.family,
        snapshot,
        args.observation,
        args.item.type
      )
    }
  }

  const op: PendingOp = {
    generation,
    key,
    previous: built.previous,
    previousOrigins: getRegistryMergedTaskPageGitHubWorkItem(
      args.item,
      sourceScope,
      key.observation
    ).githubValueOrigins,
    next: built.next,
    listOp: built.kind === 'list' ? built.listOp : undefined,
    skipMeQualifiers,
    startedAt: Date.now()
  }
  setPendingTaskPageGitHubOp(op)

  const merged = getRegistryMergedTaskPageGitHubWorkItem(args.item, sourceScope, args.observation)
  const composedFields: Partial<GitHubWorkItem> =
    built.kind === 'list'
      ? built.family === 'assignees'
        ? { assignees: merged.assignees }
        : { reviewRequests: merged.reviewRequests }
      : built.next

  args.patchWorkItem(args.item.id, composedFields, args.item.repoId, {
    sourceContext: args.sourceContext,
    ownerRepo:
      args.item.type === 'issue' ? parseGitHubIssueOrPRLink(args.item.url)?.slug : undefined,
    observation: key.observation,
    valueOrigins: merged.githubValueOrigins
  })

  establishTaskPageGitHubMembership({
    item: merged,
    sourceScope,
    queryKey: args.queryKey,
    skipMeQualifiers,
    observation: args.observation
  })
  notifyTaskPageGitHubMutationRegistry()

  return {
    generation,
    opKey: built.opKey,
    itemKey: taskPageGitHubItemKey(args.item.repoId, itemId),
    families: built.families,
    key
  }
}

export function isTaskPageGitHubMutationPendingKey(key: TaskPageGitHubMutationKey): boolean {
  return getPendingTaskPageGitHubOp(key) !== undefined
}
