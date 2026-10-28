import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { track } from '@/lib/telemetry'
import type {
  AddRepoDefaultCheckoutHandoffSource,
  EventProps
} from '../../../../shared/telemetry-events'
import type { Worktree } from '../../../../shared/worktree/types'
import { areRuntimePathsEqual } from '../../../../shared/worktree/ownership'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type DefaultCheckoutHandoffReason = EventProps<'add_repo_default_checkout_handoff'>['reason']

// The checkout at repo.path is always visible, so opening it never needs to reveal other worktrees.
export function getProjectDefaultCheckout(
  worktrees: readonly Worktree[],
  repoPath?: string
): Worktree | null {
  const selectedCheckout = repoPath
    ? worktrees.find((worktree) => areRuntimePathsEqual(worktree.path, repoPath))
    : undefined
  return selectedCheckout ?? worktrees.find((worktree) => worktree.isMainWorktree) ?? null
}

function getProjectWorktreesForHost<T extends Worktree>(
  worktrees: readonly T[],
  executionHostId?: ExecutionHostId
): T[] {
  if (!executionHostId) {
    return [...worktrees]
  }
  const parsedHost = parseExecutionHostId(executionHostId)
  return worktrees.filter((worktree) => {
    if (parsedHost?.kind === 'runtime') {
      if (worktree.runtimeOwnerEnvironmentId) {
        return worktree.runtimeOwnerEnvironmentId === parsedHost.environmentId
      }
      // Colliding repo IDs may carry only hostId, so match runtime-qualified hosts too.
      return worktree.hostId === executionHostId
    }
    if (worktree.runtimeOwnerEnvironmentId) {
      return false
    }
    if (worktree.hostId) {
      return worktree.hostId === executionHostId
    }
    return executionHostId === 'local'
  })
}

function findLoadedDefaultCheckout(
  repoId: string,
  executionHostId?: ExecutionHostId
): Worktree | null {
  const state = useAppStore.getState()
  // Match the owner row only; an ambiguous bare ID falls back to the main worktree, never the focused host.
  const owners = state.repos.filter(
    (repo) =>
      repo.id === repoId && (!executionHostId || getRepoExecutionHostId(repo) === executionHostId)
  )
  return getProjectDefaultCheckout(
    getProjectWorktreesForHost(selectWorktreesByRepo(state)[repoId] ?? [], executionHostId),
    owners.length === 1 ? owners[0].path : undefined
  )
}

async function refreshDefaultCheckout(
  repoId: string,
  executionHostId?: ExecutionHostId
): Promise<{
  worktree: Worktree | null
  reason: DefaultCheckoutHandoffReason
}> {
  const refreshed = await useAppStore.getState().fetchWorktrees(repoId, {
    requireAuthoritative: true,
    ...(executionHostId ? { executionHostId } : {})
  })
  if (!refreshed) {
    return { worktree: null, reason: 'authoritative_refresh_failed' }
  }
  const worktree = findLoadedDefaultCheckout(repoId, executionHostId)
  return {
    worktree,
    reason: worktree ? 'detected_default_checkout' : 'refreshed_default_missing'
  }
}

function resolveInitialCwdForDefaultCheckout(
  defaultCheckout: Worktree,
  selectedPath: string | undefined
): string | undefined {
  if (!selectedPath) {
    return undefined
  }
  const relativePath = relativePathInsideRoot(defaultCheckout.path, selectedPath)
  return relativePath && relativePath.length > 0 ? selectedPath : undefined
}

export async function openProjectDefaultCheckout({
  repoId,
  source,
  selectedPath,
  setHideDefaultBranchWorkspace,
  executionHostId
}: {
  repoId: string
  source: AddRepoDefaultCheckoutHandoffSource
  selectedPath?: string
  setHideDefaultBranchWorkspace: (value: boolean) => void
  executionHostId?: ExecutionHostId
}): Promise<void> {
  let defaultCheckout = findLoadedDefaultCheckout(repoId, executionHostId)
  let reason: DefaultCheckoutHandoffReason = 'loaded_default_checkout'
  if (!defaultCheckout) {
    const refreshed = await refreshDefaultCheckout(repoId, executionHostId)
    defaultCheckout = refreshed.worktree
    reason = refreshed.reason
  }

  if (!defaultCheckout) {
    track('add_repo_default_checkout_handoff', {
      source,
      result: 'revealed_project',
      reason
    })
    finalizeImportedRepoAfterSkip(useAppStore.getState(), repoId)
    return
  }

  // Onboarding must reveal its default checkout even when the normal sidebar preference hides it.
  if (defaultCheckout.isMainWorktree && useAppStore.getState().hideDefaultBranchWorkspace) {
    setHideDefaultBranchWorkspace(false)
  }
  track('add_repo_default_checkout_handoff', {
    source,
    result: defaultCheckout.isMainWorktree ? 'opened_default_checkout' : 'opened_selected_checkout',
    reason
  })
  const initialCwd = resolveInitialCwdForDefaultCheckout(defaultCheckout, selectedPath)
  if (initialCwd || executionHostId) {
    activateAndRevealWorktree(defaultCheckout.id, {
      ...(initialCwd ? { initialCwd } : {}),
      ...(executionHostId ? { executionHostId } : {})
    })
  } else {
    activateAndRevealWorktree(defaultCheckout.id)
  }
}

export async function finishProjectAddWithDefaultCheckout({
  repoId,
  source,
  selectedPath,
  closeModal,
  setHideDefaultBranchWorkspace,
  executionHostId
}: {
  repoId: string
  source: AddRepoDefaultCheckoutHandoffSource
  selectedPath?: string
  closeModal: () => void
  setHideDefaultBranchWorkspace: (value: boolean) => void
  executionHostId?: ExecutionHostId
}): Promise<void> {
  await markOnboardingProjectAdded('addedRepo')
  closeModal()
  await openProjectDefaultCheckout({
    repoId,
    source,
    selectedPath,
    executionHostId,
    setHideDefaultBranchWorkspace
  })
}
