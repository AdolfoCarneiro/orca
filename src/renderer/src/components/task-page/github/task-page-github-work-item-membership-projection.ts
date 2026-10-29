import { shouldSkipLocalViewerQualifiers } from '@/lib/task-repo-source-context'
import type { ParsedTaskQuery } from '../../../../../shared/task-query'

import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import { shouldSoftHideTaskPageGitHubWorkItem } from './task-page-github-work-item-filter-membership'

import {
  getTaskPageGitHubPendingEntries,
  getTaskPageGitHubListEntries,
  getTaskPageGitHubMembershipBases,
  membershipBasisKey,
  setTaskPageGitHubMembershipBasis
} from './task-page-github-work-item-mutation-registry'
import {
  getLastConfirmedClientEntries,
  getLastConfirmedClientValue
} from './task-page-github-confirmed-client-values'
import {
  taskPageGitHubMutationItemId,
  taskPageGitHubOwnedItemKey
} from './task-page-github-work-item-mutation-keys'
import {
  getGitHubTaskObservation,
  sameGitHubTaskObservation,
  gitHubTaskFamilyOrigin,
  type GitHubTaskObservation,
  type GitHubTaskFamily,
  type GitHubTaskValueOrigin,
  type ObservedGitHubWorkItem
} from '@/lib/github-task-observation'

import {
  createTaskPageGitHubAuthorityProjection,
  getRegistryMergedTaskPageGitHubWorkItem
} from './task-page-github-work-item-mutation-composition'
export function establishTaskPageGitHubMembership(args: {
  item: ObservedGitHubWorkItem
  sourceScope: string | null
  queryKey: string
  skipMeQualifiers: boolean
  observation?: GitHubTaskObservation
  accepted?: boolean
}): void {
  const observation = args.observation ?? getGitHubTaskObservation(args.item)
  const item = args.accepted
    ? args.item
    : getRegistryMergedTaskPageGitHubWorkItem(args.item, args.sourceScope, observation)
  const families: Partial<Record<GitHubTaskFamily, GitHubTaskValueOrigin>> = {}
  for (const family of ['state', 'assignees', 'reviewRequests'] as const) {
    families[family] = gitHubTaskFamilyOrigin(item, family) ?? {
      kind: 'ordinary'
    }
  }
  setTaskPageGitHubMembershipBasis({
    queryKey: args.queryKey,
    sourceScope: args.sourceScope,
    observation,
    repoId: item.repoId,
    itemId: taskPageGitHubMutationItemId(item),
    rawItemId: args.accepted ? '*' : item.id,
    families,
    skipMeQualifiers: args.skipMeQualifiers
  })
}
export function adoptTaskPageGitHubMembershipFamilies(
  item: ObservedGitHubWorkItem,
  sourceScope: string | null,
  queryKey: string,
  observation = getGitHubTaskObservation(item),
  adoptedFamilies: readonly string[] = ['state', 'assignees', 'reviewRequests'],
  fromAuthority = false
): void {
  const address = {
    sourceScope,
    repoId: item.repoId,
    itemId: taskPageGitHubMutationItemId(item),
    rawItemId: item.id,
    observation
  }
  for (const rawItemId of [item.id, '*']) {
    const key = membershipBasisKey({ ...address, rawItemId })
    const basis =
      getTaskPageGitHubMembershipBases().get(key) ??
      (fromAuthority && rawItemId === item.id
        ? {
            ...address,
            queryKey,
            rawItemId,
            families: {},
            skipMeQualifiers: shouldSkipLocalViewerQualifiers(observation?.source)
          }
        : undefined)
    if (!basis || basis.queryKey !== queryKey) {
      continue
    }
    const families = { ...basis.families }
    for (const family of ['state', 'assignees', 'reviewRequests'] as const) {
      if (!adoptedFamilies.includes(family)) {
        continue
      }
      const origin =
        gitHubTaskFamilyOrigin(item, family) ??
        (!observation ? { kind: 'ordinary' as const } : undefined)
      if (origin?.kind === 'ordinary' && origin.owner?.key === observation?.key) {
        families[family] = origin
      }
    }
    setTaskPageGitHubMembershipBasis({ ...basis, families })
  }
}
export function createTaskPageGitHubMembershipProjection(args: {
  query: ParsedTaskQuery
  queryKey: string
  viewerLogin: string | null
}) {
  const compose = createTaskPageGitHubAuthorityProjection()
  const liveLists = new Set<string>()
  const listCoordinate = (
    entry: {
      sourceScope: string | null
      repoId: string
      itemId: string
      observation?: GitHubTaskObservation
    },
    family: string
  ) =>
    JSON.stringify([
      taskPageGitHubOwnedItemKey(
        entry.sourceScope,
        entry.repoId,
        entry.itemId,
        entry.observation?.key
      ),
      family
    ])
  for (const entry of getTaskPageGitHubListEntries().values()) {
    liveLists.add(listCoordinate(entry, entry.family))
  }
  for (const op of getTaskPageGitHubPendingEntries().values()) {
    if (op.listOp) {
      liveLists.add(listCoordinate(op.key, op.listOp.family))
    }
  }
  return (
    item: ObservedGitHubWorkItem,
    sourceScope: string | null,
    observation = getGitHubTaskObservation(item),
    skipMeQualifiers = false
  ) => {
    const merged = compose(item, sourceScope, observation)
    const address = {
      sourceScope,
      repoId: item.repoId,
      itemId: taskPageGitHubMutationItemId(item),
      rawItemId: item.id,
      observation
    }
    const bases = getTaskPageGitHubMembershipBases()
    const basis =
      bases.get(membershipBasisKey(address)) ??
      bases.get(membershipBasisKey({ ...address, rawItemId: '*' }))
    const activeBasis = basis?.queryKey === args.queryKey ? basis : undefined
    const hasAuthority = merged !== item
    const eligible = (family: GitHubTaskFamily) => {
      const actual = gitHubTaskFamilyOrigin(merged, family)
      const origin =
        actual && actual.kind !== 'ordinary'
          ? actual
          : (activeBasis?.families[family] ?? (hasAuthority ? actual : undefined))
      if (!origin || !sameGitHubTaskObservation(origin.owner, observation)) {
        return false
      }
      if (origin.kind === 'ordinary') {
        return (
          !actual ||
          (actual.kind === 'ordinary' && sameGitHubTaskObservation(actual.owner, observation))
        )
      }
      if (origin.kind === 'scalar') {
        const entry = origin.coordinate && getLastConfirmedClientEntries().get(origin.coordinate)
        return (
          !!entry &&
          sameGitHubTaskObservation(entry.observation, observation) &&
          getLastConfirmedClientValue(
            entry.sourceScope,
            entry.repoId,
            entry.itemId,
            entry.family,
            parseGitHubIssueOrPRLink(item.url)?.slug ?? null
          ) !== undefined
        )
      }
      if (origin.kind === 'list') {
        return !!origin.coordinate && liveLists.has(origin.coordinate)
      }
      const op = origin.coordinate && getTaskPageGitHubPendingEntries().get(origin.coordinate)
      return (
        !!op && op.generation === origin.generation && op.key.observation?.key === observation?.key
      )
    }
    const query = {
      ...args.query,
      state: eligible('state') ? args.query.state : null,
      draft: eligible('state') && args.query.draft,
      assignee: eligible('assignees') ? args.query.assignee : null,
      reviewRequested: eligible('reviewRequests') ? args.query.reviewRequested : null
    }
    return {
      item: merged,
      hide: shouldSoftHideTaskPageGitHubWorkItem({
        item: merged,
        query,
        viewerLogin:
          observation?.account === null
            ? args.viewerLogin
            : observation?.account?.host === 'github.com' &&
                parseGitHubIssueOrPRLink(item.url)?.slug.host?.toLowerCase() === 'github.com'
              ? observation.account.user
              : null,
        skipMeQualifiers: activeBasis?.skipMeQualifiers ?? skipMeQualifiers
      }),
      hasAuthority,
      hasKnowledge: !!activeBasis || hasAuthority
    }
  }
}
