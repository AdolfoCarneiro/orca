import { applyTaskPageGitHubListOps } from './task-page-github-work-item-mutation-patches'

import {
  listInput,
  type ListEntry,
  type ListRetirement
} from './task-page-github-work-item-mutation-registry'

import {
  taskPageGitHubMutationItemId,
  taskPageGitHubOwnedItemKey
} from './task-page-github-work-item-mutation-keys'

import {
  patchObservedGitHubWorkItem,
  type ObservedGitHubWorkItem
} from '@/lib/github-task-observation'

import type {
  PendingListOp,
  TaskPageGitHubListFamily
} from './task-page-github-work-item-registry-types'

export function dependsOnTaskPageGitHubListRetirement(
  item: ObservedGitHubWorkItem,
  retirement: ListRetirement
): boolean {
  const { address } = retirement
  const origin = item.githubValueOrigins?.[address.family]
  return (
    item.repoId === address.repoId &&
    taskPageGitHubMutationItemId(item) === address.itemId &&
    origin?.listLifetime === retirement.fromLifetime &&
    origin.owner?.key === address.observation?.key
  )
}
export function restoreTaskPageGitHubListOutput(
  item: ObservedGitHubWorkItem,
  retirement: ListRetirement
): ObservedGitHubWorkItem {
  const { address, restoration, toLifetime } = retirement
  const origin = item.githubValueOrigins?.[address.family]
  if (!origin || !dependsOnTaskPageGitHubListRetirement(item, retirement)) {
    return item
  }
  return patchObservedGitHubWorkItem(
    item,
    { [address.family]: restoration.users },
    {
      [address.family]: toLifetime ? { ...origin, listLifetime: toLifetime } : restoration.origin
    }
  )
}

export function composeListDestination(
  item: ObservedGitHubWorkItem,
  family: TaskPageGitHubListFamily,
  entry: ListEntry | undefined,
  ops: readonly PendingListOp[],
  retirement?: ListRetirement
): ObservedGitHubWorkItem {
  if (retirement) {
    item = restoreTaskPageGitHubListOutput(item, retirement)
  }
  if (!entry) {
    return item
  }
  const destination = listInput(item, family, entry.observation)
  const base = destination.kind === 'full' ? destination : entry.base
  const protection = entry.protection
  const facts: PendingListOp[] =
    protection.kind === 'addressed'
      ? [...protection.facts].map(([login, fact]) => ({
          family,
          kind: fact.user ? 'add' : 'remove',
          logins: [login],
          users: fact.user ? [fact.user] : undefined
        }))
      : []
  const users = applyTaskPageGitHubListOps(
    protection.kind === 'whole' ? protection.expectedUsers : base.users,
    [...facts, ...ops]
  )
  return patchObservedGitHubWorkItem(
    item,
    { [family]: users },
    {
      [family]: {
        kind: 'list',
        owner: entry.observation,
        coordinate: JSON.stringify([
          taskPageGitHubOwnedItemKey(
            entry.sourceScope,
            entry.repoId,
            entry.itemId,
            entry.observation?.key
          ),
          family
        ]),
        listLifetime: entry.lifetime
      }
    }
  )
}
