import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  suppressNewExternalWorktreeInbox,
  type NewExternalWorktreesInboxActionState
} from '../../new-external-worktrees-inbox-actions'
import { buildNewExternalWorktreesInboxCandidates } from '../../new-external-worktrees-inbox-candidates'

export function useSidebarExternalWorktreeCards(args: {
  repos: readonly Repo[]
  visibleReposForRows: readonly Repo[]
  detectedWorktreesByRepo: AppState['detectedWorktreesByRepo']
  filterRepoIds: readonly string[]
}) {
  const { repos, visibleReposForRows, detectedWorktreesByRepo, filterRepoIds } = args
  const updateRepo = useAppStore((s) => s.updateRepo)
  const settings = useAppStore((s) => s.settings)
  const visibilityDefaultsByHost = useAppStore((s) => s.worktreeVisibilityDefaultsByHost)
  const [newExternalWorktreeInboxActionState, setNewExternalWorktreeInboxActionState] = useState<
    Map<string, NewExternalWorktreesInboxActionState>
  >(new Map())
  const [suppressExternalWorktreeInboxRepoId, setSuppressExternalWorktreeInboxRepoId] = useState<
    string | null
  >(null)

  const newExternalWorktreesInboxByRepo = useMemo(
    () =>
      buildNewExternalWorktreesInboxCandidates({
        repos: visibleReposForRows,
        detectedWorktreesByRepo,
        filterRepoIds,
        settings,
        visibilityDefaultsByHost
      }),
    [
      detectedWorktreesByRepo,
      filterRepoIds,
      settings,
      visibilityDefaultsByHost,
      visibleReposForRows
    ]
  )

  const setNewExternalWorktreeInboxState = useCallback(
    (projectId: string, state: NewExternalWorktreesInboxActionState | null) => {
      setNewExternalWorktreeInboxActionState((previous) => {
        const next = new Map(previous)
        if (state) {
          next.set(projectId, state)
        } else {
          next.delete(projectId)
        }
        return next
      })
    },
    []
  )

  const handleOpenSuppressExternalWorktreeInbox = useCallback((projectId: string) => {
    setSuppressExternalWorktreeInboxRepoId(projectId)
  }, [])

  const handleConfirmSuppressExternalWorktreeInbox = useCallback(async () => {
    if (!suppressExternalWorktreeInboxRepoId) {
      return
    }
    const projectId = suppressExternalWorktreeInboxRepoId
    const repo = repos.find((candidate) => candidate.id === projectId)
    if (!repo) {
      setSuppressExternalWorktreeInboxRepoId(null)
      return
    }
    const inboxWorktrees = newExternalWorktreesInboxByRepo.get(projectId)?.inboxWorktrees ?? []
    const suppressed = await suppressNewExternalWorktreeInbox({
      projectId,
      repo,
      worktreePaths: inboxWorktrees.map((worktree) => worktree.path),
      updateRepo,
      setInboxState: setNewExternalWorktreeInboxState
    })
    if (suppressed) {
      setSuppressExternalWorktreeInboxRepoId(null)
    }
  }, [
    newExternalWorktreesInboxByRepo,
    repos,
    setNewExternalWorktreeInboxState,
    suppressExternalWorktreeInboxRepoId,
    updateRepo
  ])

  return {
    newExternalWorktreeInboxActionState,
    newExternalWorktreesInboxByRepo,
    suppressExternalWorktreeInboxRepoId,
    setSuppressExternalWorktreeInboxRepoId,
    handleOpenSuppressExternalWorktreeInbox,
    handleConfirmSuppressExternalWorktreeInbox
  }
}
