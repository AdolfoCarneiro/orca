import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'

/**
 * A local agent list refused while its WSL distro was stopped stays failed. The user opening a
 * launch picker is a user act, so it retries that list as a wake (E9); a known list is reused.
 */
export function useAgentPickerRefusedWake(
  userOpened: boolean,
  detectionTarget: AgentDetectionTarget | undefined
): void {
  const worktreeId =
    userOpened && detectionTarget?.kind === 'local'
      ? (detectionTarget.worktreeId ?? null)
      : undefined
  const refused = useAppStore(
    (state) =>
      worktreeId !== undefined && state.readLocalAgentInventory(worktreeId).state === 'failed'
  )
  useEffect(() => {
    if (refused && worktreeId !== undefined) {
      void useAppStore.getState().ensureDetectedAgentsForPicker(worktreeId)
    }
  }, [refused, worktreeId])
}
