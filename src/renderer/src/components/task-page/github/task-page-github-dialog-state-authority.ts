import type { GitHubTaskValueOrigin } from '@/lib/github-task-observation'
import { createGitHubTaskObservationIndex } from '@/lib/github-task-observation'
import { useAppStore } from '@/store'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import {
  deleteLastConfirmedClientValue,
  getLastConfirmedClientValue,
  getLastConfirmedClientEntry
} from './task-page-github-confirmed-client-values'
import {
  getTaskPageGitHubMutationQueryKey,
  setLastConfirmedClientValue
} from './task-page-github-work-item-mutation-registry'
import { markTaskPageGitHubFamiliesDirty } from './task-page-github-work-item-quiet-state'
import {
  taskPageGitHubOwnedItemKey,
  taskPageGitHubLastConfirmedKey
} from './task-page-github-work-item-mutation-keys'

function markStateFamilyDirty(
  repoId: string,
  itemId: string,
  sourceScope: string | null,
  observation: ReturnType<ReturnType<typeof createGitHubTaskObservationIndex>>,
  queryKey: string | null
): void {
  if (queryKey !== null && queryKey === getTaskPageGitHubMutationQueryKey()) {
    markTaskPageGitHubFamiliesDirty(
      queryKey,
      taskPageGitHubOwnedItemKey(sourceScope, repoId, itemId, observation?.key),
      ['state']
    )
  }
}

/** Hold confirmed dialog state in the registry until search catches up; matching quiet adoption releases it so external reverts can win. */
export function assertTaskPageGitHubDialogStateAuthority(args: {
  repoId: string
  itemId: string
  state: GitHubWorkItem['state']
  sourceContext?: TaskSourceContext | null
  ownerRepo?: GitHubOwnerRepo | null
  previousOrigin?: GitHubTaskValueOrigin
}): {
  observation: ReturnType<ReturnType<typeof createGitHubTaskObservationIndex>>
  revert: () => boolean
  origin: () => GitHubTaskValueOrigin | undefined
} {
  const sourceScope =
    args.sourceContext?.provider === 'github' ? getTaskSourceCacheScope(args.sourceContext) : null
  const queryKey = getTaskPageGitHubMutationQueryKey()
  const currentObservation = () =>
    createGitHubTaskObservationIndex(
      useAppStore.getState().repos ?? [],
      () => args.sourceContext ?? null
    )({ repoId: args.repoId, repoHostId: args.sourceContext?.hostId }, args.sourceContext)
  const observation = currentObservation()
  const previousEntry = getLastConfirmedClientEntry(sourceScope, args.repoId, args.itemId, 'state')
  const previous = getLastConfirmedClientValue(
    sourceScope,
    args.repoId,
    args.itemId,
    'state',
    args.ownerRepo
  )
  markStateFamilyDirty(args.repoId, args.itemId, sourceScope, observation, queryKey)
  setLastConfirmedClientValue(
    sourceScope,
    args.repoId,
    args.itemId,
    'state',
    args.state,
    args.ownerRepo,
    observation
  )
  return {
    observation,
    origin: () => {
      const entry = getLastConfirmedClientEntry(sourceScope, args.repoId, args.itemId, 'state')
      return entry
        ? {
            kind: 'scalar',
            owner: entry.observation,
            coordinate: taskPageGitHubLastConfirmedKey(
              sourceScope,
              args.repoId,
              args.itemId,
              'state'
            )
          }
        : args.previousOrigin
    },
    revert: () => {
      const current = getLastConfirmedClientValue(
        sourceScope,
        args.repoId,
        args.itemId,
        'state',
        args.ownerRepo
      )
      // A matching search adopt or newer mutation owns the state now.
      if (current !== args.state) {
        return false
      }
      if (currentObservation()?.key === observation?.key) {
        markStateFamilyDirty(args.repoId, args.itemId, sourceScope, observation, queryKey)
      }
      if (previous === undefined) {
        deleteLastConfirmedClientValue(
          sourceScope,
          args.repoId,
          args.itemId,
          'state',
          args.ownerRepo
        )
      } else {
        setLastConfirmedClientValue(
          sourceScope,
          args.repoId,
          args.itemId,
          'state',
          previous,
          args.ownerRepo,
          previousEntry?.observation
        )
      }
      return true
    }
  }
}
