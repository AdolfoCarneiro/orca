import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import {
  findTaskPageDialogWorkItem,
  type TaskPageDialogWorkItemKey
} from '../task-page-cache-selectors'

export function useTaskPageGitHubDialogWorkItem(
  dialogKey: TaskPageDialogWorkItemKey
): GitHubWorkItem | null {
  const id = dialogKey?.id
  const repoId = dialogKey?.repoId
  const url = dialogKey?.url
  const repoHostId = dialogKey?.repoHostId
  const selectWorkItem = useMemo(() => {
    const key =
      id !== undefined && repoId !== undefined && url !== undefined
        ? { id, repoId, url, repoHostId }
        : null
    let previousCache: AppState['workItemsCache'] | undefined
    let selected: GitHubWorkItem | null = null
    return (state: Pick<AppState, 'workItemsCache'>): GitHubWorkItem | null => {
      if (!key) {
        return null
      }
      if (previousCache !== state.workItemsCache) {
        selected = findTaskPageDialogWorkItem(state.workItemsCache, key)
        previousCache = state.workItemsCache
      }
      return selected
    }
  }, [id, repoId, url, repoHostId])
  return useAppStore(selectWorkItem)
}
