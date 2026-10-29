import { taskPageGitHubResumeCache } from '@/components/task-page/github/task-page-github-resume-cache'

import {
  createTaskPageGitHubAuthorityProjection,
  createTaskPageGitHubListCompositionProgram,
  restoreTaskPageGitHubListOutput
} from '@/components/task-page/github/task-page-github-work-item-mutation-composition'

import { taskPageGitHubMutationItemId } from '@/components/task-page/github/task-page-github-work-item-mutation-keys'

import {
  listInput,
  type ListRetirement
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import { patchObservedGitHubWorkItem } from '@/lib/github-task-observation'

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

import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

import type { AppState } from '../types'

type RefreshTarget = NonNullable<ReturnType<typeof captureGitHubTaskTarget>>
type ReadPatch = { target: RefreshTarget; item: ObservedGitHubWorkItem; body: string }
type ReadListProgram = { retirements: readonly ListRetirement[] }
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
  const listDomains = new Set(
    owners.flatMap((owner) =>
      owner.observation
        ? owner.observation.associations.map((association) =>
            JSON.stringify([owner.source.repoId, association.scope])
          )
        : [JSON.stringify([owner.source.repoId, githubTaskSourceKey(owner.source.sourceContext)])]
    )
  )
  const program: (ReadPatch | ReadListProgram)[] = []
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
        program.push({ target, item, body })
      }
    },
    retire(index: ReadonlyMap<string, readonly ListRetirement[]>) {
      for (const domain of listDomains) {
        const retirements = index.get(domain)
        if (retirements?.length) {
          program.push({ retirements })
        }
      }
    },
    projectPatches() {
      return program.filter((p): p is ReadPatch => 'target' in p && p.target.current())
    },
    apply(
      items: readonly GitHubWorkItem[],
      current: readonly GitHubWorkItem[] = []
    ): GitHubWorkItem[] {
      if (!program.length) {
        return items as GitHubWorkItem[]
      } // SAFETY: callers never mutate the unchanged readonly array.
      const keyOf = (repoId: string, itemId: string) => `${repoId}\0${itemId}`
      const instructions = new Map<string, (ReadPatch | ListRetirement)[]>()
      for (const operation of program) {
        for (const instruction of 'retirements' in operation
          ? operation.retirements
          : [operation]) {
          if ('target' in instruction && !instruction.target.current()) {
            continue
          }
          const key =
            'target' in instruction
              ? keyOf(instruction.item.repoId, taskPageGitHubMutationItemId(instruction.item))
              : keyOf(instruction.address.repoId, instruction.address.itemId)
          const group = instructions.get(key) ?? []
          group.push(instruction)
          instructions.set(key, group)
        }
      }
      const latest = new Map(current.map((row: ObservedGitHubWorkItem) => [rowKey(row), row]))
      let projection: ReturnType<typeof createTaskPageGitHubAuthorityProjection> | undefined
      return items.map((row: ObservedGitHubWorkItem) => {
        let result = row
        const retiredFamilies = new Set<'assignees' | 'reviewRequests'>()
        for (const instruction of instructions.get(
          keyOf(row.repoId, taskPageGitHubMutationItemId(row))
        ) ?? []) {
          if ('target' in instruction) {
            const patch = instruction
            if (!patch.target.matches(row)) {
              continue
            }
            const candidate =
              latest.get(rowKey(row, patch.target.hostId)) ?? latest.get(rowKey(row, ''))
            const present =
              candidate &&
              (!getGitHubTaskObservation(candidate) ||
                patch.target.observations.some(
                  (owner) => owner?.key === getGitHubTaskObservation(candidate)?.key
                )) &&
              patch.target.matches(candidate)
                ? candidate
                : patch.item
            result = {
              ...result,
              ...githubTaskContent(present),
              githubObservation: getGitHubTaskObservation(present),
              githubValueOrigins: present.githubValueOrigins
            }
          } else {
            const { address } = instruction
            retiredFamilies.add(address.family)
            if (
              result.githubValueOrigins?.[address.family]?.listLifetime !== instruction.fromLifetime
            ) {
              continue
            }
            const candidate =
              latest.get(rowKey(row, address.observation?.hostId)) ?? latest.get(rowKey(row, ''))
            result =
              candidate && listInput(candidate, address.family, address.observation).kind === 'full'
                ? patchObservedGitHubWorkItem(
                    result,
                    { [address.family]: candidate[address.family] },
                    { [address.family]: candidate.githubValueOrigins?.[address.family] }
                  )
                : restoreTaskPageGitHubListOutput(result, instruction)
          }
        }
        // Only dependent output participates; ordinary incoming provider rows stay raw.
        for (const family of retiredFamilies) {
          const origin = result.githubValueOrigins?.[family]
          if (origin?.listLifetime) {
            result = (projection ??= createTaskPageGitHubAuthorityProjection()).list(result, {
              address: {
                sourceScope: origin.owner ? githubTaskSourceKey(origin.owner.source) : null,
                repoId: result.repoId,
                itemId: taskPageGitHubMutationItemId(result),
                itemType: result.type,
                family,
                observation: origin.owner
              }
            })
          }
        }
        return result
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

export function markGitHubTaskListRetirements(retirements: readonly ListRetirement[]) {
  const index = new Map<string, ListRetirement[]>()
  for (const retirement of retirements) {
    const { address } = retirement
    const key = JSON.stringify([address.repoId, address.sourceScope])
    const group = index.get(key) ?? []
    group.push(retirement)
    index.set(key, group)
  }
  for (const read of liveTaskReads) {
    read.retire(index)
  }
  taskPageGitHubResumeCache.patch(
    () => true,
    createTaskPageGitHubListCompositionProgram(
      retirements.map((retirement) => ({ address: retirement.address, retirement }))
    )
  )
}
