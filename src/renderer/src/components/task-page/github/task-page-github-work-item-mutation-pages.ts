import { observeExistingListBases } from './task-page-github-work-item-mutation-registry'

import { taskPageGitHubMutationItemId } from './task-page-github-work-item-mutation-keys'

import type { ListComposition } from './task-page-github-work-item-mutation-registry'

import type { Repo } from '../../../../../shared/repo-types'

import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'

import { getTaskPageRepoSourceContext } from '../task-page-source-context'

import {
  createGitHubTaskObservationIndex,
  captureGitHubTaskObservation
} from '@/lib/github-task-observation'

import type { GitHubTaskRead } from '@/store/github/request-coordination'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import { parseTaskQuery, type ParsedTaskQuery } from '../../../../../shared/task-query'

import {
  getGitHubTaskObservation,
  patchObservedGitHubWorkItem,
  type ObservedGitHubWorkItem,
  type GitHubTaskObservation
} from '@/lib/github-task-observation'

import { githubTaskIdentity, githubTaskSourceKey } from '@/lib/github-task-target'

import {
  createTaskPageGitHubAuthorityProjection,
  createTaskPageGitHubMembershipProjection,
  adoptTaskPageGitHubMembershipFamilies
} from './task-page-github-work-item-mutation-composition'

import type { GitHubWorkItemPatch } from '@/store/github/cache-model'

export type TaskPageGitHubProjectionContext = {
  query: ParsedTaskQuery
  queryKey: string
  viewerLogin: string | null
  ownerOf?: (
    item: Pick<GitHubWorkItem, 'repoId' | 'repoHostId'>
  ) => GitHubTaskObservation | undefined
  owns?: (owner: GitHubTaskObservation | undefined) => boolean
}
export function createTaskPageGitHubProjectionContext(
  repos: readonly Repo[],
  query: ParsedTaskQuery,
  queryKey: string,
  viewerLogin: string | null
): TaskPageGitHubProjectionContext {
  const keys = new Set(
    repos.map(
      (repo) =>
        captureGitHubTaskObservation(repo, getTaskPageRepoSourceContext(repo, 'github'))?.key
    )
  )
  return {
    query,
    queryKey,
    viewerLogin,
    owns: (owner) => !owner || owner.aliases.some((key) => keys.has(key)),
    ownerOf: createGitHubTaskObservationIndex(repos, (repo) =>
      getTaskPageRepoSourceContext(repo, 'github')
    )
  }
}
export function admitTaskPageGitHubListInputs(
  items: readonly GitHubWorkItem[],
  context?: TaskPageGitHubProjectionContext,
  fillOnly = false
): void {
  const current = items.filter((item) => {
    const owner = getGitHubTaskObservation(item)
    const actual = context?.ownerOf?.(item)
    return !!owner && (!context?.ownerOf || actual?.key === owner.key)
  })
  observeExistingListBases(current, fillOnly)
}
export function taskPageGitHubObservedRowKey(item: GitHubWorkItem): string {
  const owner = getGitHubTaskObservation(item)
  return JSON.stringify([
    owner?.key ?? item.repoHostId ?? null,
    item.repoId,
    githubTaskIdentity(item),
    item.id
  ])
}
export function patchTaskPageGitHubWorkItemPages(
  pages: readonly (GitHubWorkItem[] | null)[],
  itemKey: { id: string; repoId: string },
  patch: Partial<ObservedGitHubWorkItem>,
  shouldPatch?: (item: GitHubWorkItem) => boolean,
  listComposition: readonly ListComposition[] = []
): (GitHubWorkItem[] | null)[] {
  const projection = createTaskPageGitHubAuthorityProjection()
  let nextPages: (GitHubWorkItem[] | null)[] | undefined
  pages.forEach((page, pageIndex) => {
    if (!page) {
      return
    }
    let nextPage: GitHubWorkItem[] | undefined
    page.forEach((item, itemIndex) => {
      if (
        item.repoId !== itemKey.repoId ||
        (shouldPatch ? !shouldPatch(item) : item.id !== itemKey.id)
      ) {
        return
      }
      let updated = Object.keys(patch).length
        ? patchObservedGitHubWorkItem(item, patch, patch.githubValueOrigins ?? {})
        : item
      for (const plan of listComposition) {
        updated = projection.list(updated, plan)
      }
      if (updated === item) {
        return
      }
      nextPage ??= page.slice()
      nextPage[itemIndex] = updated
    })
    if (nextPage) {
      nextPages ??= pages.slice()
      nextPages[pageIndex] = nextPage
    }
  })
  return nextPages ?? (pages as (GitHubWorkItem[] | null)[])
}

export function applyPendingTaskPageGitHubMutationsToItems(
  items: readonly GitHubWorkItem[],
  context?: TaskPageGitHubProjectionContext
): GitHubWorkItem[] {
  const compose = createTaskPageGitHubAuthorityProjection()
  return items.map((item) => {
    const owner = context?.ownerOf?.(item) ?? getGitHubTaskObservation(item)
    return compose(item, owner ? githubTaskSourceKey(owner.source) : null, owner)
  })
}
export function reapplyPendingTaskPageGitHubMutationsToCache(args: {
  items: readonly GitHubWorkItem[]
  patchWorkItems: (patches: readonly GitHubWorkItemPatch[]) => void
  context?: TaskPageGitHubProjectionContext
}): void {
  admitTaskPageGitHubListInputs(args.items, args.context, true)
  const compose = createTaskPageGitHubAuthorityProjection()
  const patches: GitHubWorkItemPatch[] = []
  for (const item of args.items) {
    const owner = args.context?.ownerOf?.(item) ?? getGitHubTaskObservation(item)
    const merged = compose(item, owner ? githubTaskSourceKey(owner.source) : null, owner)
    if (merged === item) {
      continue
    }
    patches.push({
      itemId: item.id,
      patch: {
        state: merged.state,
        autoMergeEnabled: merged.autoMergeEnabled
      },
      repoId: item.repoId,
      options: {
        sourceContext: owner?.source,
        observation: owner,
        valueOrigins: {
          state: merged.githubValueOrigins?.state,
          autoMerge: merged.githubValueOrigins?.autoMerge
        },
        listComposition: (['assignees', 'reviewRequests'] as const).map((family) => ({
          address: {
            sourceScope: owner ? githubTaskSourceKey(owner.source) : null,
            repoId: item.repoId,
            itemId: taskPageGitHubMutationItemId(item),
            itemType: item.type,
            observation: owner,
            family
          }
        })),
        ownerRepo: item.type === 'issue' ? parseGitHubIssueOrPRLink(item.url)?.slug : undefined
      }
    })
  }
  args.patchWorkItems(patches)
}
export function materializeTaskPageItemList(args: {
  networkItems: readonly GitHubWorkItem[]
  previousItems: readonly GitHubWorkItem[]
  queryKey: string
  context?: TaskPageGitHubProjectionContext
}): GitHubWorkItem[] {
  const context = args.context ?? {
    query: parseTaskQuery(''),
    queryKey: args.queryKey,
    viewerLogin: null
  }
  const compose = createTaskPageGitHubAuthorityProjection()
  const project = createTaskPageGitHubMembershipProjection(context)
  const byKey = new Map<string, GitHubWorkItem>()
  for (const item of args.networkItems) {
    const owner = context.ownerOf?.(item) ?? getGitHubTaskObservation(item)
    const scope = owner ? githubTaskSourceKey(owner.source) : null
    adoptTaskPageGitHubMembershipFamilies(item, scope, args.queryKey, owner)
    byKey.set(taskPageGitHubObservedRowKey(item), compose(item, scope, owner))
  }
  for (const item of args.previousItems) {
    const key = taskPageGitHubObservedRowKey(item)
    if (byKey.has(key)) {
      continue
    }
    const owner = context.ownerOf?.(item) ?? getGitHubTaskObservation(item)
    const scope = owner ? githubTaskSourceKey(owner.source) : null
    const projected = project(item, scope, owner)
    if (compose.pending(item, scope, owner).length || (projected.hide && projected.hasKnowledge)) {
      byKey.set(key, projected.item)
    }
  }
  return [...byKey.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
}
export function reconcileTaskPagePagesAfterQuietRefresh(args: {
  pages: readonly (GitHubWorkItem[] | null)[]
  queryKey: string
  authorityPage: number
  authorityItems: readonly GitHubWorkItem[]
  membershipChanged: boolean
  visiblePage?: number
  visibleItems?: readonly GitHubWorkItem[]
  context?: TaskPageGitHubProjectionContext
}): (GitHubWorkItem[] | null)[] {
  const next = [...args.pages]
  const lastPage = args.visiblePage ?? args.authorityPage
  while (next.length <= lastPage) {
    next.push(null)
  }
  next[args.authorityPage] = materializeTaskPageItemList({
    networkItems: args.authorityItems,
    previousItems: args.pages[args.authorityPage] ?? [],
    queryKey: args.queryKey,
    context: args.context
  })
  if (args.visiblePage !== undefined && args.visibleItems !== undefined) {
    if (args.membershipChanged) {
      for (let page = args.authorityPage + 1; page < args.visiblePage; page++) {
        next[page] = null
      }
    }
    next[args.visiblePage] = materializeTaskPageItemList({
      networkItems: args.visibleItems,
      previousItems: args.pages[args.visiblePage] ?? [],
      queryKey: args.queryKey,
      context: args.context
    })
  }
  if (args.membershipChanged) {
    next.length = lastPage + 1
  }
  return next
}

/** In-place overlay per page; preserves multi-page structure; no retain. */
export function overlayPendingOnTaskPagePages(
  pages: readonly GitHubWorkItem[][],
  context?: TaskPageGitHubProjectionContext
): GitHubWorkItem[][] {
  return pages.map((page) => applyPendingTaskPageGitHubMutationsToItems(page, context))
}

export function materializeTaskPageGitHubRead(
  read: GitHubTaskRead,
  pages: readonly (GitHubWorkItem[] | null)[],
  items: readonly GitHubWorkItem[],
  queryKey: string,
  context?: TaskPageGitHubProjectionContext
): GitHubWorkItem[] {
  const current = pages.flatMap((page) => page ?? [])
  return materializeTaskPageItemList({
    networkItems: read.apply(items, current),
    previousItems: current,
    queryKey,
    context
  })
}
export function restoreTaskPageGitHubReadPage(
  read: GitHubTaskRead,
  pages: readonly (GitHubWorkItem[] | null)[],
  items: readonly GitHubWorkItem[],
  page: number,
  context?: TaskPageGitHubProjectionContext
): (GitHubWorkItem[] | null)[] {
  const next = [...pages]
  while (next.length <= page) {
    next.push(null)
  }
  next[page] =
    overlayPendingOnTaskPagePages(
      [
        read.apply(
          items,
          pages.flatMap((p) => p ?? [])
        )
      ],
      context
    )[0] ?? []
  return next
}

export { transitionTaskPageGitHubMutationQuery } from './task-page-github-work-item-query-transition'
