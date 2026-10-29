import { useMemo } from 'react'
import { getRepoProjectGroupKey } from '../../../../shared/project-grouping'
import { buildProjectHostSetupOptions } from '@/lib/project-host-setup-options'
import { buildNewWorkspaceCreateTargetOptions } from '@/lib/new-workspace-project-options'
import type { WorkspaceCreationTargetResolution } from '@/lib/project-host-workspace-target'
import type { Repo } from '../../../../shared/repo-types'
import type { ComposerRuntimeTargetSelectionInput } from './composer-target-input-contracts'

export function useComposerProjectOptions(
  input: Pick<
    ComposerRuntimeTargetSelectionInput,
    | 'eligibleRepos'
    | 'hostOptions'
    | 'projectHostSetups'
    | 'projects'
    | 'settings'
    | 'projectGroups'
    | 'selectedProjectGroup'
  >,
  selectedWorkspaceTarget: WorkspaceCreationTargetResolution,
  selectedRepo: Repo | undefined
) {
  const {
    eligibleRepos,
    hostOptions,
    projectHostSetups,
    projects,
    settings,
    projectGroups,
    selectedProjectGroup
  } = input
  const selectedRepoProjectId =
    selectedWorkspaceTarget.status === 'ready' ? selectedWorkspaceTarget.target.projectId : null

  const selectedProjectId = selectedProjectGroup
    ? `project-group:${selectedProjectGroup.id}`
    : selectedRepo
      ? getRepoProjectGroupKey(selectedRepo, settings)
      : selectedRepoProjectId

  const selectedProjectHostSetupId =
    !selectedProjectGroup && selectedWorkspaceTarget.status === 'ready'
      ? selectedWorkspaceTarget.target.projectHostSetupId
      : null

  const projectHostSetupOptions = useMemo(
    () =>
      buildProjectHostSetupOptions({
        projectId: selectedRepoProjectId,
        groupKey: selectedProjectId,
        settings,
        projectHostSetups,
        eligibleRepos,
        hosts: hostOptions
      }),
    [
      eligibleRepos,
      hostOptions,
      projectHostSetups,
      selectedRepoProjectId,
      selectedProjectId,
      settings
    ]
  )

  const projectOptions = useMemo(
    () =>
      buildNewWorkspaceCreateTargetOptions({
        projects,
        projectHostSetups,
        eligibleRepos,
        projectGroups,
        hosts: hostOptions,
        settings
      }),
    [eligibleRepos, hostOptions, projectGroups, projectHostSetups, projects, settings]
  )

  return {
    selectedRepoProjectId,
    selectedProjectId,
    selectedProjectHostSetupId,
    projectHostSetupOptions,
    projectOptions
  }
}
