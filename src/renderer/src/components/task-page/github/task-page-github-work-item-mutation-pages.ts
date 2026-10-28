import type { GitHubTaskRead } from '@/store/github/request-coordination'
import { taskPageGitHubMutationItemId } from './task-page-github-work-item-mutation-keys'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import { getRegistryMergedTaskPageGitHubWorkItem } from './task-page-github-work-item-mutation-composition'
import {
  getStickyHideEntry,
  hasConfirmedAuthorityForItem,
  hasPendingTaskPageGitHubOpsForItem,
  resolveItemSourceScope
} from './task-page-github-work-item-mutation-registry'
import { taskPageGitHubItemKey } from './task-page-github-work-item-mutation-keys'
import type { TaskPageGitHubPatchWorkItem } from './task-page-github-work-item-mutation-types'

export function patchTaskPageGitHubWorkItemPages(
  pages: readonly (GitHubWorkItem[] | null)[],
  itemKey: { id: string; repoId: string },
  patch: Partial<GitHubWorkItem>,
  shouldPatch?: (item: GitHubWorkItem) => boolean
): (GitHubWorkItem[] | null)[] {
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
      nextPage ??= page.slice()
      nextPage[itemIndex] = { ...item, ...patch }
    })
    if (nextPage) {
      nextPages ??= pages.slice()
      nextPages[pageIndex] = nextPage
    }
  })
  return nextPages ?? (pages as (GitHubWorkItem[] | null)[])
}

/** Match each item to pending/confirmed authority by repoId + itemId + remembered sourceScope. */
export function applyPendingTaskPageGitHubMutationsToItems(
  items: readonly GitHubWorkItem[]
): GitHubWorkItem[] {
  return items.map((item) => {
    const sourceScope = resolveItemSourceScope(item.repoId, taskPageGitHubMutationItemId(item))
    return getRegistryMergedTaskPageGitHubWorkItem(item, sourceScope)
  })
}

export function reapplyPendingTaskPageGitHubMutationsToCache(args: {
  items: readonly GitHubWorkItem[]
  patchWorkItem: TaskPageGitHubPatchWorkItem
  sourceContextByRepoId?: ReadonlyMap<string, TaskSourceContext | null | undefined>
}): void {
  for (const item of args.items) {
    const itemId = taskPageGitHubMutationItemId(item)
    const sourceScope = resolveItemSourceScope(item.repoId, itemId)
    const hasAuthority =
      hasPendingTaskPageGitHubOpsForItem(item.repoId, itemId) ||
      hasConfirmedAuthorityForItem(item.repoId, itemId) ||
      hasConfirmedAuthorityForItem(item.repoId, item.id)
    if (!hasAuthority) {
      continue
    }
    const merged = getRegistryMergedTaskPageGitHubWorkItem(item, sourceScope)
    args.patchWorkItem(
      item.id,
      {
        state: merged.state,
        assignees: merged.assignees,
        reviewRequests: merged.reviewRequests,
        autoMergeEnabled: merged.autoMergeEnabled
      },
      item.repoId,
      {
        sourceContext: args.sourceContextByRepoId?.get(item.repoId),
        ownerRepo: parseGitHubIssueOrPRLink(item.url)?.slug
      }
    )
  }
}

/** Full-replace flat list: overlay + retain pending/confirmed-omitted rows (K18). */
export function materializeTaskPageItemList(args: {
  networkItems: readonly GitHubWorkItem[]
  previousItems: readonly GitHubWorkItem[]
  queryKey: string
}): GitHubWorkItem[] {
  const overlaid = applyPendingTaskPageGitHubMutationsToItems(args.networkItems)
  const byKey = new Map(
    overlaid.map((item) => [
      taskPageGitHubItemKey(item.repoId, taskPageGitHubMutationItemId(item)),
      item
    ])
  )
  for (const item of args.previousItems) {
    const itemId = taskPageGitHubMutationItemId(item)
    const k = taskPageGitHubItemKey(item.repoId, itemId)
    if (byKey.has(k)) {
      continue
    }
    // Retain pending rows for rollback and query-sticky confirmed exits for search lag; other confirms must not become stale ghosts.
    const hasPending = hasPendingTaskPageGitHubOpsForItem(item.repoId, itemId)
    const sticky =
      getStickyHideEntry(k) ?? getStickyHideEntry(taskPageGitHubItemKey(item.repoId, item.id))
    const hasConfirmedStickyHide =
      (hasConfirmedAuthorityForItem(item.repoId, itemId) ||
        hasConfirmedAuthorityForItem(item.repoId, item.id)) &&
      sticky?.queryKey === args.queryKey
    if (!hasPending && !hasConfirmedStickyHide) {
      continue
    }
    const scope = resolveItemSourceScope(item.repoId, itemId)
    byKey.set(k, getRegistryMergedTaskPageGitHubWorkItem(item, scope))
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
}): (GitHubWorkItem[] | null)[] {
  const next = [...args.pages]
  const lastPage = args.visiblePage ?? args.authorityPage
  while (next.length <= lastPage) {
    next.push(null)
  }
  next[args.authorityPage] = materializeTaskPageItemList({
    networkItems: args.authorityItems,
    previousItems: args.pages[args.authorityPage] ?? [],
    queryKey: args.queryKey
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
      queryKey: args.queryKey
    })
  }
  if (args.membershipChanged) {
    next.length = lastPage + 1
  }
  return next
}

/** In-place overlay per page; preserves multi-page structure; no retain. */
export function overlayPendingOnTaskPagePages(
  pages: readonly GitHubWorkItem[][]
): GitHubWorkItem[][] {
  return pages.map((page) => applyPendingTaskPageGitHubMutationsToItems(page))
}

export function materializeTaskPageGitHubRead(
  read: GitHubTaskRead,
  pages: readonly (GitHubWorkItem[] | null)[],
  items: readonly GitHubWorkItem[],
  queryKey: string
): GitHubWorkItem[] {
  const current = pages.flatMap((page) => page ?? [])
  return materializeTaskPageItemList({
    networkItems: read.apply(items, current),
    previousItems: current,
    queryKey
  })
}
export function restoreTaskPageGitHubReadPage(
  read: GitHubTaskRead,
  pages: readonly (GitHubWorkItem[] | null)[],
  items: readonly GitHubWorkItem[],
  page: number
): (GitHubWorkItem[] | null)[] {
  const next = [...pages]
  while (next.length <= page) {
    next.push(null)
  }
  next[page] =
    overlayPendingOnTaskPagePages([
      read.apply(
        items,
        pages.flatMap((p) => p ?? [])
      )
    ])[0] ?? []
  return next
}
