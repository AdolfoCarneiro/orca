import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

import {
  freezeTaskPageGitHubUsers,
  getRegistryMergedTaskPageGitHubWorkItem
} from './task-page-github-work-item-mutation-composition'
import {
  setConfirmedListSnapshot,
  setLastConfirmedClientValue
} from './task-page-github-work-item-mutation-registry'

import type { TaskPageGitHubMutationKey } from './task-page-github-work-item-registry-types'
import type { TaskPageGitHubPatchWorkItem } from './task-page-github-work-item-mutation-types'

export function applyServerEntityIfPresent(
  key: TaskPageGitHubMutationKey,
  opts: {
    item: GitHubWorkItem
    serverEntity?: Partial<GitHubWorkItem>
    patchWorkItem?: TaskPageGitHubPatchWorkItem
    sourceContext?: TaskSourceContext | null
  }
): void {
  if (!opts.serverEntity || !opts.patchWorkItem) {
    return
  }
  const entityPatch: Partial<GitHubWorkItem> = {}
  if (opts.serverEntity.state !== undefined) {
    entityPatch.state = opts.serverEntity.state
    setLastConfirmedClientValue(
      key.sourceScope,
      key.repoId,
      opts.item.id,
      'state',
      opts.serverEntity.state,
      undefined,
      key.observation
    )
  }
  if (opts.serverEntity.autoMergeEnabled !== undefined) {
    entityPatch.autoMergeEnabled = opts.serverEntity.autoMergeEnabled
    setLastConfirmedClientValue(
      key.sourceScope,
      key.repoId,
      opts.item.id,
      'autoMerge',
      opts.serverEntity.autoMergeEnabled,
      undefined,
      key.observation
    )
  }
  if (opts.serverEntity.assignees) {
    const users = freezeTaskPageGitHubUsers(opts.serverEntity.assignees)
    setConfirmedListSnapshot(
      key.sourceScope,
      key.repoId,
      key.itemId,
      'assignees',
      users,
      key.observation,
      key.itemType
    )
    entityPatch.assignees = users
  }
  if (opts.serverEntity.reviewRequests) {
    const users = freezeTaskPageGitHubUsers(opts.serverEntity.reviewRequests)
    setConfirmedListSnapshot(
      key.sourceScope,
      key.repoId,
      key.itemId,
      'reviewRequests',
      users,
      key.observation,
      key.itemType
    )
    entityPatch.reviewRequests = users
  }
  if (Object.keys(entityPatch).length > 0) {
    opts.patchWorkItem(opts.item.id, entityPatch, key.repoId, {
      sourceContext: opts.sourceContext,
      ownerRepo:
        opts.item.type === 'issue' ? parseGitHubIssueOrPRLink(opts.item.url)?.slug : undefined,
      observation: key.observation,
      valueOrigins: getRegistryMergedTaskPageGitHubWorkItem(
        opts.item,
        key.sourceScope,
        key.observation
      ).githubValueOrigins
    })
  }
}
