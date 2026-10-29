import {
  captureGitHubTaskObservation,
  getGitHubTaskObservation,
  type ObservedGitHubWorkItem
} from '@/lib/github-task-observation'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

import { getGitHubSourceRuntimeTarget } from '@/lib/github-source-runtime-context'
import {
  githubTaskIdentity,
  githubTaskSourceKey,
  githubTaskContent,
  type captureGitHubTaskTarget
} from '@/lib/github-task-target'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import type { PRComment } from '../../../../shared/github/comment-types'
import type { IssueInfo, PRInfo } from '../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GetProjectViewTableResult } from '../../../../shared/github/project-result-types'
import type { AppState } from '../types'
import { matchesRepoCacheEviction, type RepoCacheEviction } from './cache-identity'

export type InflightPR = {
  promise: Promise<PRInfo | null>
  force: boolean
  generation: number
  lookupHintKey: string
}
export type InflightChecks = {
  promise: Promise<PRCheckDetail[]>
  requestId: number
  force: boolean
  noCache: boolean
}
export type InflightWorkItems = {
  promise: Promise<readonly GitHubWorkItem[]>
  requestId: number
  force: boolean
  noCache: boolean
  requireComplete: boolean
}
export type InflightProjectView = {
  promise: Promise<GetProjectViewTableResult>
  requestId: number
  force: boolean
}

export const inflightPRRequests = new Map<string, InflightPR>()
export const inflightIssueRequests = new Map<string, Promise<IssueInfo | null>>()
export const inflightChecksRequests = new Map<string, InflightChecks>()
export const inflightCommentsRequests = new Map<string, Promise<PRComment[]>>()
export const inflightWorkItemsRequests = new Map<string, InflightWorkItems>()
export const inflightProjectViewRequests = new Map<string, InflightProjectView>()
export const prRequestGenerations = new Map<string, number>()
export const prRefreshStartedHostedReviewEntries = new Map<
  string,
  AppState['hostedReviewCache'][string] | undefined
>()

let providerRequestSequence = 0

/** Stamp identifying one provider request, captured before it awaits so it can recheck ownership after. */
export function nextProviderRequestId(): number {
  providerRequestSequence += 1
  return providerRequestSequence
}

/** Bounded upgrade waits permit concurrent strengths; only current key owner may cache replies or late weaker results gain fresh timestamps over newer data. */
export function ownsInflightRequest<T extends { requestId: number }>(
  registry: ReadonlyMap<string, T>,
  key: string,
  requestId: number
): boolean {
  return registry.get(key)?.requestId === requestId
}

export function _getGitHubPRRequestGenerationCountForTest(): number {
  return prRequestGenerations.size
}

export function _getGitHubPRRefreshStartedEntryCountForTest(): number {
  return prRefreshStartedHostedReviewEntries.size
}

export function _clearGitHubPRRefreshStartedEntriesForTest(): void {
  prRefreshStartedHostedReviewEntries.clear()
}

const PROVIDER_REQUEST_CONCURRENCY = 8
let providerRequestsInFlight = 0
const providerRequestWaiters: (() => void)[] = []

export async function acquireProviderRequestSlot(): Promise<void> {
  if (providerRequestsInFlight < PROVIDER_REQUEST_CONCURRENCY) {
    providerRequestsInFlight += 1
    return
  }
  await new Promise<void>((resolve) => providerRequestWaiters.push(resolve))
}

export function releaseProviderRequestSlot(): void {
  const next = providerRequestWaiters.shift()
  if (next) {
    next()
    return
  }
  providerRequestsInFlight -= 1
}

export function clearInflightWorkItemsForRepo(eviction: RepoCacheEviction): void {
  for (const key of Array.from(inflightWorkItemsRequests.keys())) {
    if (matchesRepoCacheEviction(key, eviction)) {
      inflightWorkItemsRequests.delete(key)
    }
  }
}

type RefreshTarget = NonNullable<ReturnType<typeof captureGitHubTaskTarget>>
type ReadPatch = { target: RefreshTarget; item: ObservedGitHubWorkItem; body: string }
const liveTaskReads = new Set<GitHubTaskRead>()
const rowKey = (row: GitHubWorkItem, host = row.repoHostId ?? '') =>
  `${row.repoId}\0${host}\0${githubTaskIdentity(row)}`
export type GitHubTaskRead = ReturnType<typeof beginGitHubTaskRead>
/** Marks live only through their final owner's commit; queued pure updaters keep their local marks. */
export function beginGitHubTaskRead(
  sources: readonly { repoId: string; path?: string; sourceContext?: TaskSourceContext | null }[],
  projectTarget?: RuntimeClientTarget,
  state?: Pick<AppState, 'repos'>
) {
  const lookup = getGitHubRepoLookupIndex(state?.repos)
  const owners = sources.map((source) => {
    const repo = source.sourceContext?.hostId
      ? source.path
        ? lookup.findOnHost(source.sourceContext.hostId, source.repoId, source.path)
        : lookup.findByHostAndId(source.sourceContext.hostId, source.repoId)
      : lookup.findByIdOrPath(source.repoId, source.path ?? '')
    return { source, observation: repo && captureGitHubTaskObservation(repo, source.sourceContext) }
  })
  const scopes = new Set(
    owners.flatMap((owner) => (owner.observation ? [owner.observation.key] : []))
  )
  const legacy = new Set(
    owners
      .filter((owner) => !owner.observation)
      .map((owner) =>
        JSON.stringify([owner.source.repoId, githubTaskSourceKey(owner.source.sourceContext)])
      )
  )
  const patches = new Map<string, ReadPatch>()
  const read = {
    mark(target: RefreshTarget, item: GitHubWorkItem, body: string) {
      if (
        target.observations.some((owner) => owner && scopes.has(owner.key)) ||
        target.sources.some((source) =>
          legacy.has(JSON.stringify([target.item.repoId, githubTaskSourceKey(source)]))
        ) ||
        (projectTarget &&
          JSON.stringify(projectTarget) ===
            JSON.stringify(getGitHubSourceRuntimeTarget(target.source)))
      ) {
        patches.set(rowKey(item, target.hostId), { target, item, body })
      }
    },
    projectPatches() {
      return [...patches.values()].filter((p) => p.target.current())
    },
    apply(
      items: readonly GitHubWorkItem[],
      current: readonly GitHubWorkItem[] = []
    ): GitHubWorkItem[] {
      if (!patches.size) {
        return items as GitHubWorkItem[]
      } // SAFETY: callers never mutate the unchanged readonly array.
      const valid = new Map<string, ReadPatch>()
      for (const [key, patch] of patches) {
        if (patch.target.current()) {
          valid.set(key, patch)
          valid.set(rowKey(patch.item, ''), patch)
        }
      }
      const latest = new Map(current.map((row: ObservedGitHubWorkItem) => [rowKey(row), row]))
      return items.map((row) => {
        const patch =
          valid.get(rowKey(row)) ?? (!row.repoHostId ? valid.get(rowKey(row, '')) : undefined)
        if (!patch || !patch.target.matches(row)) {
          return row
        }
        const candidate =
          latest.get(rowKey(row, patch.target.hostId)) ?? latest.get(rowKey(row, ''))
        const present =
          candidate &&
          (!getGitHubTaskObservation(candidate) ||
            patch.target.observations.some(
              (owner) => owner?.key === getGitHubTaskObservation(candidate)?.key
            ))
            ? candidate
            : undefined
        return {
          ...row,
          ...githubTaskContent(present && patch.target.matches(present) ? present : patch.item),
          githubObservation: getGitHubTaskObservation(present ?? patch.item),
          githubValueOrigins: (present ?? patch.item).githubValueOrigins
        }
      })
    },
    dispose() {
      liveTaskReads.delete(read)
    }
  }
  liveTaskReads.add(read)
  return read
}
export function markGitHubTaskReads(target: RefreshTarget, item: GitHubWorkItem, body: string) {
  for (const read of liveTaskReads) {
    read.mark(target, item, body)
  }
}
