import {
  getLastConfirmedClientEntry,
  getLastConfirmedClientValue
} from '@/components/task-page/github/task-page-github-confirmed-client-values'
import { taskPageGitHubLastConfirmedKey } from '@/components/task-page/github/task-page-github-work-item-mutation-keys'
import type { GitHubTaskFamily, GitHubTaskValueOrigin } from '@/lib/github-task-observation'
import {
  patchObservedGitHubWorkItem,
  createGitHubTaskObservationIndex
} from '@/lib/github-task-observation'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

import type { AppState } from '../types'

import type { GitHubPatchWorkItemOptions } from './cache-model'

import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'

import { repoCacheKeyHostId } from '../../../../shared/github/github-cache-key'

type PatchRequest = {
  itemId: string
  patch: Partial<GitHubWorkItem>
  repoId?: string | null
  options?: GitHubPatchWorkItemOptions
}
type PreparedPatch = PatchRequest & {
  order: number
  sourceScope: string | null
  sourceScopes: readonly string[]
  repositoryKey: string | null
  fields: Map<string, { order: number; value: unknown }>
  origins: Map<GitHubTaskFamily, { order: number; value: GitHubTaskValueOrigin | undefined }>
}
function bucketMatchesPatch(key: string, request: PreparedPatch): boolean {
  const { repoId, options, sourceScope, sourceScopes, repositoryKey } = request
  if (options?.hostId && repoId && repoCacheKeyHostId(key, [repoId]) !== options.hostId) {
    return false
  }
  if (options?.hostId && !sourceScope && key.startsWith('github:')) {
    return false
  }
  return (
    !sourceScopes.length ||
    sourceScopes.some((scope) => key === scope || key.startsWith(`${scope}::`)) ||
    (!key.startsWith('github:') &&
      !!(repoId && options?.hostId && repositoryKey && options?.matches))
  )
}
function rowMatchesPatch(item: GitHubWorkItem, request: PreparedPatch): boolean {
  if (
    (request.repoId && item.repoId !== request.repoId) ||
    (request.options?.matches ? !request.options.matches(item) : item.id !== request.itemId)
  ) {
    return false
  }
  const repository = request.repositoryKey ? parseGitHubIssueOrPRLink(item.url)?.slug : undefined
  return (
    !request.repositoryKey ||
    (!!repository && githubRepoIdentityKey(repository) === request.repositoryKey)
  )
}
export function reduceWorkItemPatches(
  s: AppState,
  requests: readonly PatchRequest[],
  indexed: boolean
) {
  const observationFor = createGitHubTaskObservationIndex(s.repos, () => null)
  const validated = new Map<
    NonNullable<GitHubPatchWorkItemOptions['observation']>,
    Map<string, boolean>
  >()
  const prepared: PreparedPatch[] = []
  // Scope -> renderer repo -> raw row -> canonical restriction. All indexes die with this call.
  const scopes = new Map<
    string | null,
    Map<string, Map<string, Map<string | null, PreparedPatch>>>
  >()
  requests.forEach((request, order) => {
    const { options } = request
    const sourceScope =
      options?.sourceContext?.provider === 'github'
        ? getTaskSourceCacheScope(options.sourceContext)
        : null
    if (options?.observation) {
      let owners = validated.get(options.observation)
      if (!owners) {
        validated.set(options.observation, (owners = new Map()))
      }
      const sourceKey = options.sourceContext ? getTaskSourceCacheScope(options.sourceContext) : ''
      if (!owners.has(sourceKey)) {
        owners.set(
          sourceKey,
          observationFor(
            { repoId: options.observation.repoId, repoHostId: options.observation.hostId },
            options.sourceContext
          )?.key === options.observation.key
        )
      }
      if (!owners.get(sourceKey)) {
        return
      }
    }
    const sourceScopes =
      options?.sourceContexts?.map(getTaskSourceCacheScope) ?? (sourceScope ? [sourceScope] : [])
    const repositoryKey = options?.ownerRepo ? githubRepoIdentityKey(options.ownerRepo) : null
    let previous: PreparedPatch | undefined
    let restrictions: Map<string | null, PreparedPatch> | undefined
    if (indexed && request.repoId) {
      let repos = scopes.get(sourceScope)
      if (!repos) {
        scopes.set(sourceScope, (repos = new Map()))
      }
      let rows = repos.get(request.repoId)
      if (!rows) {
        repos.set(request.repoId, (rows = new Map()))
      }
      restrictions = rows.get(request.itemId)
      if (!restrictions) {
        rows.set(request.itemId, (restrictions = new Map()))
      }
      previous = restrictions.get(repositoryKey)
    }
    const next = previous ?? {
      ...request,
      order,
      sourceScope,
      sourceScopes,
      repositoryKey,
      fields: new Map(),
      origins: new Map()
    }
    for (const [field, value] of Object.entries(request.patch)) {
      next.fields.set(field, { order, value })
    }
    for (const family of ['state', 'autoMerge', 'assignees', 'reviewRequests'] as const) {
      if (options?.valueOrigins && family in options.valueOrigins) {
        next.origins.set(family, { order, value: options.valueOrigins[family] })
      }
    }
    if (!previous) {
      prepared.push(next)
      restrictions?.set(repositoryKey, next)
    }
  })
  if (!prepared.length) {
    return s
  }
  let nextCache: AppState['workItemsCache'] | undefined
  for (const [key, entry] of Object.entries(s.workItemsCache)) {
    if (!entry?.data) {
      continue
    }
    const bucketIndexes = indexed
      ? [null, ...[6, 7].map((n) => key.split(':').slice(0, n).join(':'))]
          .filter((scope, i, all) => all.indexOf(scope) === i)
          .flatMap((scope) => {
            const rows = scopes.get(scope)
            return rows ? [rows] : []
          })
      : []
    if (indexed && !bucketIndexes.length) {
      continue
    }
    const consumed = new Set<PreparedPatch>()
    let updatedItems: GitHubWorkItem[] | undefined
    entry.data.forEach((item, index) => {
      const candidates = indexed
        ? bucketIndexes.flatMap((repos) => {
            const restrictions = repos.get(item.repoId)?.get(item.id)
            if (!restrictions) {
              return []
            }
            const unrestricted = restrictions.get(null)
            const repository =
              restrictions.size > (unrestricted ? 1 : 0)
                ? parseGitHubIssueOrPRLink(item.url)?.slug
                : undefined
            const restricted = repository
              ? restrictions.get(githubRepoIdentityKey(repository))
              : undefined
            return [unrestricted, restricted].filter(
              (candidate): candidate is PreparedPatch => !!candidate
            )
          })
        : prepared
      const applicable = candidates.filter(
        (request) =>
          (!consumed.has(request) || !!request.options?.matches) &&
          bucketMatchesPatch(key, request) &&
          rowMatchesPatch(item, request)
      )
      if (!applicable.length) {
        return
      }
      const fields = new Map<string, { order: number; value: unknown }>()
      const originFields = new Map<
        GitHubTaskFamily,
        { order: number; value: GitHubTaskValueOrigin | undefined }
      >()
      for (const request of applicable) {
        consumed.add(request)
        for (const [field, value] of request.fields) {
          if ((fields.get(field)?.order ?? -1) <= value.order) {
            fields.set(field, value)
          }
        }
        for (const [family, value] of request.origins) {
          if ((originFields.get(family)?.order ?? -1) <= value.order) {
            originFields.set(family, value)
          }
        }
      }
      const patch: Partial<GitHubWorkItem> = Object.fromEntries(
        [...fields].map(([field, { value }]) => [field, value])
      )
      const origins: Partial<Record<GitHubTaskFamily, GitHubTaskValueOrigin | undefined>> =
        Object.fromEntries([...originFields].map(([family, { value }]) => [family, value]))
      if (!indexed) {
        const request = applicable[0]
        for (const family of ['state', 'autoMerge'] as const) {
          const value = family === 'state' ? patch.state : patch.autoMergeEnabled
          if (value === undefined || family in origins) {
            continue
          }
          const scalar = getLastConfirmedClientEntry(
            request.sourceScope,
            item.repoId,
            request.itemId,
            family
          )
          if (
            scalar &&
            getLastConfirmedClientValue(
              request.sourceScope,
              item.repoId,
              request.itemId,
              family,
              parseGitHubIssueOrPRLink(item.url)?.slug
            ) === value
          ) {
            origins[family] = {
              kind: 'scalar',
              owner: scalar.observation,
              coordinate: taskPageGitHubLastConfirmedKey(
                request.sourceScope,
                item.repoId,
                request.itemId,
                family
              )
            }
          }
        }
      }
      updatedItems ??= [...entry.data!]
      updatedItems[index] = Object.keys(origins).length
        ? patchObservedGitHubWorkItem(item, patch, origins)
        : { ...item, ...patch }
    })
    if (updatedItems) {
      nextCache ??= { ...s.workItemsCache }
      nextCache[key] = { ...entry, data: updatedItems }
    }
  }
  return nextCache ? { workItemsCache: nextCache } : s
}
