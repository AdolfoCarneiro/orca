import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import {
  clearLastConfirmedClientValues,
  deleteLastConfirmedClientValue,
  getLastConfirmedClientEntry,
  setLastConfirmedClientValue as storeLastConfirmedClientValue
} from './task-page-github-confirmed-client-values'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../../../shared/github/pull-request-types'
import type { GitHubTaskObservation } from '@/lib/github-task-observation'
import type {
  PendingOp,
  TaskPageGitHubMembershipBasis,
  TaskPageGitHubListFamily,
  TaskPageGitHubMutationKey
} from './task-page-github-work-item-registry-types'
import {
  serializeTaskPageGitHubMutationKey,
  taskPageGitHubOwnedItemKey,
  taskPageGitHubSnapshotKey
} from './task-page-github-work-item-mutation-keys'
import { clearTaskPageGitHubQuietStates } from './task-page-github-work-item-quiet-state'

const listeners = new Set<() => void>()
const pendingByKey = new Map<string, PendingOp>()
const generations = new Map<string, number>()
type ListSnapshot = {
  sourceScope: string | null
  repoId: string
  itemId: string
  family: TaskPageGitHubListFamily
  itemType: GitHubWorkItem['type']
  observation?: GitHubTaskObservation
  users: GitHubAssignableUser[]
}
const confirmedSnapshots = new Map<string, ListSnapshot>()
const membershipBases = new Map<string, TaskPageGitHubMembershipBasis>()
let mutationQueryKey: string | null = null
let activationKey: string | null = null

export function subscribeTaskPageGitHubMutationRegistry(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
let notificationDepth = 0
let notificationPending = false
export function batchTaskPageGitHubMutationRegistry<T>(operation: () => T): T {
  notificationDepth++
  try {
    return operation()
  } finally {
    notificationDepth--
    if (!notificationDepth && notificationPending) {
      notificationPending = false
      notifyTaskPageGitHubMutationRegistry()
    }
  }
}
export function notifyTaskPageGitHubMutationRegistry(): void {
  if (notificationDepth) {
    notificationPending = true
    return
  }
  for (const listener of listeners) {
    listener()
  }
}
export function getTaskPageGitHubPendingEntries(): ReadonlyMap<string, PendingOp> {
  return pendingByKey
}
export function getTaskPageGitHubListEntries(): ReadonlyMap<string, ListSnapshot> {
  return confirmedSnapshots
}
export function getTaskPageGitHubMembershipBases(): ReadonlyMap<
  string,
  TaskPageGitHubMembershipBasis
> {
  return membershipBases
}
export function membershipBasisKey(
  basis: Pick<
    TaskPageGitHubMembershipBasis,
    'sourceScope' | 'repoId' | 'itemId' | 'rawItemId' | 'observation'
  >
): string {
  return JSON.stringify([
    taskPageGitHubOwnedItemKey(
      basis.sourceScope,
      basis.repoId,
      basis.itemId,
      basis.observation?.key
    ),
    basis.rawItemId
  ])
}
export function setTaskPageGitHubMembershipBasis(basis: TaskPageGitHubMembershipBasis): void {
  if (basis.queryKey === mutationQueryKey) {
    membershipBases.set(membershipBasisKey(basis), basis)
  }
}
export function deleteTaskPageGitHubMembershipBasis(key: string): void {
  membershipBases.delete(key)
}
export function clearTaskPageGitHubConfirmedAuthority(): void {
  confirmedSnapshots.clear()
  clearLastConfirmedClientValues()
}
function setTaskPageGitHubMutationQueryKeyNow(queryKey: string): void {
  if (mutationQueryKey === queryKey) {
    return
  }
  mutationQueryKey = queryKey
  activationKey = null
  membershipBases.clear()
  clearTaskPageGitHubConfirmedAuthority()
  clearTaskPageGitHubQuietStates()
  for (const serialized of generations.keys()) {
    if (!pendingByKey.has(serialized)) {
      generations.delete(serialized)
    }
  }
  notifyTaskPageGitHubMutationRegistry()
}
export function setTaskPageGitHubMembershipActivation(key: string): void {
  if (activationKey === key) {
    return
  }
  activationKey = key
  membershipBases.clear()
  clearTaskPageGitHubQuietStates()
  notifyTaskPageGitHubMutationRegistry()
}
export function isTaskPageGitHubMutationQueryKeyCurrent(queryKey: string): boolean {
  return mutationQueryKey === queryKey
}
export function getTaskPageGitHubMutationQueryKey(): string | null {
  return mutationQueryKey
}
export function getPendingTaskPageGitHubOp(key: TaskPageGitHubMutationKey): PendingOp | undefined {
  return pendingByKey.get(serializeTaskPageGitHubMutationKey(key))
}
export function nextTaskPageGitHubMutationGeneration(key: TaskPageGitHubMutationKey): number {
  const serialized = serializeTaskPageGitHubMutationKey(key)
  const next = (generations.get(serialized) ?? 0) + 1
  generations.set(serialized, next)
  return next
}
export function setPendingTaskPageGitHubOp(op: PendingOp): void {
  pendingByKey.set(serializeTaskPageGitHubMutationKey(op.key), op)
}
export function deletePendingTaskPageGitHubOp(
  key: TaskPageGitHubMutationKey
): PendingOp | undefined {
  const serialized = serializeTaskPageGitHubMutationKey(key)
  const existing = pendingByKey.get(serialized)
  pendingByKey.delete(serialized)
  return existing
}
export function listPendingTaskPageGitHubOpsForItem(
  repoId: string,
  itemId: string,
  sourceScope: string | null,
  observation?: GitHubTaskObservation
): PendingOp[] {
  return [...pendingByKey.values()]
    .filter(
      (op) =>
        op.key.repoId === repoId &&
        op.key.itemId === itemId &&
        op.key.sourceScope === sourceScope &&
        op.key.observation?.key === observation?.key
    )
    .sort((a, b) => a.startedAt - b.startedAt)
}
export function hasPendingTaskPageGitHubOpsForItem(
  repoId: string,
  itemId: string,
  sourceScope: string | null,
  observation?: GitHubTaskObservation
): boolean {
  return listPendingTaskPageGitHubOpsForItem(repoId, itemId, sourceScope, observation).length > 0
}
function snapshotKey(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily,
  observation?: GitHubTaskObservation,
  itemType: GitHubWorkItem['type'] = 'issue'
): string {
  const raw = taskPageGitHubSnapshotKey(sourceScope, repoId, itemId, family)
  return itemType === 'issue' && observation ? JSON.stringify([raw, observation.key]) : raw
}
export function getConfirmedListSnapshot(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily,
  observation?: GitHubTaskObservation,
  itemType: GitHubWorkItem['type'] = 'issue'
): GitHubAssignableUser[] | undefined {
  const entry = confirmedSnapshots.get(
    snapshotKey(sourceScope, repoId, itemId, family, observation, itemType)
  )
  return entry?.observation?.key === observation?.key ? entry?.users : undefined
}
export function setConfirmedListSnapshot(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily,
  users: readonly GitHubAssignableUser[],
  observation?: GitHubTaskObservation,
  itemType: GitHubWorkItem['type'] = 'issue'
): void {
  confirmedSnapshots.set(snapshotKey(sourceScope, repoId, itemId, family, observation, itemType), {
    sourceScope,
    repoId,
    itemId,
    family,
    itemType,
    observation,
    users: [...users]
  })
}
export function deleteConfirmedListSnapshot(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily,
  observation?: GitHubTaskObservation,
  itemType: GitHubWorkItem['type'] = 'issue'
): void {
  const key = snapshotKey(sourceScope, repoId, itemId, family, observation, itemType)
  if (confirmedSnapshots.get(key)?.observation?.key === observation?.key) {
    confirmedSnapshots.delete(key)
  }
}
export function setLastConfirmedClientValue(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string,
  value: unknown,
  ownerRepo?: GitHubOwnerRepo | null,
  observation?: GitHubTaskObservation
): void {
  storeLastConfirmedClientValue(sourceScope, repoId, itemId, family, value, ownerRepo, observation)
}

export function clearConfirmedAuthorityForItem(
  repoId: string,
  itemId: string,
  sourceScope: string | null,
  observation?: GitHubTaskObservation,
  itemType?: GitHubWorkItem['type']
): void {
  for (const family of ['assignees', 'reviewRequests'] as const) {
    deleteConfirmedListSnapshot(sourceScope, repoId, itemId, family, observation, itemType)
  }
  for (const family of ['state', 'autoMerge']) {
    const entry = getLastConfirmedClientEntry(sourceScope, repoId, itemId, family)
    if (entry?.observation?.key === observation?.key) {
      deleteLastConfirmedClientValue(sourceScope, repoId, itemId, family)
    }
  }
}
export function resetTaskPageGitHubMutationRegistryForTests(): void {
  pendingByKey.clear()
  generations.clear()
  confirmedSnapshots.clear()
  membershipBases.clear()
  clearLastConfirmedClientValues()
  clearTaskPageGitHubQuietStates()
  mutationQueryKey = null
  activationKey = null
  listeners.clear()
}

export function setTaskPageGitHubMutationQueryKey(queryKey: string): void {
  batchTaskPageGitHubMutationRegistry(() => setTaskPageGitHubMutationQueryKeyNow(queryKey))
}

export type { TaskPageGitHubAuthority } from './task-page-github-work-item-authority-read'
export {
  getTaskPageGitHubConfirmedAuthorities,
  hasConfirmedAuthorityForItem,
  getTaskPageGitHubMutationSnapshot,
  getTaskPageGitHubPendingOwnerKeys
} from './task-page-github-work-item-authority-read'
