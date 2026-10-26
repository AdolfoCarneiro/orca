import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { track } from '@/lib/telemetry'
import type {
  AddRepoDefaultCheckoutHandoffSource,
  EventProps
} from '../../../../shared/telemetry-events'
import type { Worktree } from '../../../../shared/worktree/types'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import {
  getHiddenExternalWorktrees,
  hasCompletedInitialExternalWorktreeImportPrompt,
  mergeExternalWorktreeInboxPaths
} from '../../../../shared/external-worktree-inbox'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { repoMatchesHostIdentity } from '@/store/slices/repo-host-identity'
import type { RepoUpdate } from '@/store/repos/repo-state'
import type { Repo } from '../../../../shared/repo-types'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

type DefaultCheckoutHandoffReason = EventProps<'add_repo_default_checkout_handoff'>['reason']

export function getProjectDefaultCheckout(worktrees: readonly Worktree[]): Worktree | null {
  return worktrees.find((worktree) => worktree.isMainWorktree) ?? null
}

function getProjectInitialCheckout<T extends Worktree>(
  worktrees: readonly T[],
  anchorPaths: readonly (string | undefined)[]
): T | null {
  for (const anchorPath of anchorPaths) {
    if (!anchorPath) {
      continue
    }
    // Deepest match, so a linked checkout nested inside the primary opens itself.
    const containing = worktrees
      .filter((worktree) => relativePathInsideRoot(worktree.path, anchorPath) !== null)
      .sort((left, right) => right.path.length - left.path.length)[0]
    if (containing) {
      return containing
    }
  }
  return worktrees.find((worktree) => worktree.isMainWorktree) ?? null
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

function getLoadedProjectWorktrees(repoId: string, executionHostId?: ExecutionHostId): Worktree[] {
  return getProjectWorktreesForHost(
    selectWorktreesByRepo(useAppStore.getState())[repoId] ?? [],
    executionHostId
  )
}

function ownerRefreshOptions(executionHostId?: ExecutionHostId) {
  return {
    requireAuthoritative: true as const,
    ...(executionHostId ? { executionHostId } : {})
  }
}

// Never falls back to the focused host: an ID shared across hosts needs the captured owner.
function findProjectRepo(repoId: string, executionHostId?: ExecutionHostId): Repo | null {
  const matches = useAppStore
    .getState()
    .repos.filter((repo) =>
      executionHostId ? repoMatchesHostIdentity(repo, repoId, executionHostId) : repo.id === repoId
    )
  return matches.length === 1 ? matches[0] : null
}

// Writes go to the row the update was derived from, so merged path lists never cross hosts.
function updateProjectRepo(repo: Repo, updates: RepoUpdate): Promise<boolean> {
  return useAppStore
    .getState()
    .updateRepo(repo.id, updates, { hostId: getRepoExecutionHostId(repo) })
}

async function resolveInitialCheckout(
  repoId: string,
  anchorPaths: readonly (string | undefined)[],
  executionHostId?: ExecutionHostId
): Promise<{
  worktree: Worktree | null
  reason: DefaultCheckoutHandoffReason
}> {
  const loaded = getLoadedProjectWorktrees(repoId, executionHostId)
  const detected = selectDetectedWorktreesByRepo(useAppStore.getState())[repoId]
  if (detected?.authoritative !== true) {
    const worktree = getProjectInitialCheckout(loaded, anchorPaths)
    return {
      worktree,
      reason: worktree ? 'loaded_default_checkout' : 'no_authoritative_detection'
    }
  }
  // Detection includes hidden checkouts, so a picked hidden checkout wins over the visible primary.
  const target = getProjectInitialCheckout(
    getProjectWorktreesForHost(detected.worktrees, executionHostId),
    anchorPaths
  )
  if (!target) {
    return { worktree: null, reason: 'no_default_checkout' }
  }
  const loadedTarget = loaded.find((worktree) => worktree.id === target.id)
  if (loadedTarget) {
    return { worktree: loadedTarget, reason: 'loaded_default_checkout' }
  }
  if (!target.visible) {
    // Import only the opened checkout; repo-wide visibility would also reveal every sibling.
    const repo = findProjectRepo(repoId, executionHostId)
    const updated =
      repo !== null &&
      (await updateProjectRepo(repo, {
        importedExternalWorktreePaths: mergeExternalWorktreeInboxPaths(
          repo.importedExternalWorktreePaths,
          [target.path]
        )
      }))
    if (!updated) {
      return { worktree: null, reason: 'show_detected_default_failed' }
    }
  }
  const refreshed = await useAppStore
    .getState()
    .fetchWorktrees(repoId, ownerRefreshOptions(executionHostId))
  if (!refreshed) {
    return { worktree: null, reason: 'authoritative_refresh_failed' }
  }
  const worktree =
    getLoadedProjectWorktrees(repoId, executionHostId).find(
      (candidate) => candidate.id === target.id
    ) ?? null
  return {
    worktree,
    reason: worktree ? 'detected_default_checkout' : 'refreshed_default_missing'
  }
}

// Other non-Orca worktrees stay hidden; resolving the initial show/keep-hidden prompt swaps its
// card for the compact hidden-worktrees hint, whose action opens the visibility dialog.
async function keepSiblingWorktreesBehindHint(
  repoId: string,
  executionHostId?: ExecutionHostId
): Promise<void> {
  const repo = findProjectRepo(repoId, executionHostId)
  const detected = selectDetectedWorktreesByRepo(useAppStore.getState())[repoId]
  if (!repo || hasCompletedInitialExternalWorktreeImportPrompt(repo) || !detected) {
    return
  }
  const hiddenSiblings = getHiddenExternalWorktrees({
    ...detected,
    worktrees: getProjectWorktreesForHost(detected.worktrees, executionHostId)
  })
  if (hiddenSiblings.length > 0) {
    // A failed write only leaves the initial prompt card in place.
    await updateProjectRepo(repo, { externalWorktreeVisibilityPromptDismissedAt: Date.now() })
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
  // A project registered at a linked checkout reopens that checkout rather than the hidden primary.
  const projectPath = findProjectRepo(repoId, executionHostId)?.path
  const { worktree: checkout, reason } = await resolveInitialCheckout(
    repoId,
    [selectedPath, projectPath],
    executionHostId
  )
  await keepSiblingWorktreesBehindHint(repoId, executionHostId)

  if (!checkout) {
    track('add_repo_default_checkout_handoff', {
      source,
      result: 'revealed_project',
      reason
    })
    finalizeImportedRepoAfterSkip(useAppStore.getState(), repoId)
    return
  }

  // Onboarding must reveal its default checkout even when the normal sidebar preference hides it.
  if (checkout.isMainWorktree && useAppStore.getState().hideDefaultBranchWorkspace) {
    setHideDefaultBranchWorkspace(false)
  }
  track('add_repo_default_checkout_handoff', {
    source,
    result: checkout.isMainWorktree ? 'opened_default_checkout' : 'opened_selected_checkout',
    reason
  })
  const initialCwd = resolveInitialCwdForDefaultCheckout(checkout, selectedPath)
  if (initialCwd || executionHostId) {
    activateAndRevealWorktree(checkout.id, {
      ...(initialCwd ? { initialCwd } : {}),
      ...(executionHostId ? { executionHostId } : {})
    })
  } else {
    activateAndRevealWorktree(checkout.id)
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
