import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

// Reuse the empty result to avoid allocating on every store write while the picker is closed.
const NO_DUPLICATE_CANDIDATES: readonly GitHubWorkItem[] = []

export function useGitHubDuplicateIssueCandidates(
  item: Pick<GitHubWorkItem, 'repoId' | 'number'>,
  pickerOpen: boolean
): readonly GitHubWorkItem[] {
  const { repoId, number } = item
  const selectCandidates = useMemo(() => {
    let previousCache: AppState['workItemsCache'] | undefined
    let candidates = NO_DUPLICATE_CANDIDATES
    return (state: Pick<AppState, 'workItemsCache'>): readonly GitHubWorkItem[] => {
      if (!pickerOpen) {
        return NO_DUPLICATE_CANDIDATES
      }
      if (previousCache === state.workItemsCache) {
        return candidates
      }
      const deduped = new Map<number, GitHubWorkItem>()
      for (const entry of Object.values(state.workItemsCache)) {
        for (const candidate of entry.data ?? []) {
          if (
            candidate.type === 'issue' &&
            candidate.repoId === repoId &&
            candidate.number !== number &&
            !deduped.has(candidate.number)
          ) {
            deduped.set(candidate.number, candidate)
          }
        }
      }
      candidates = Array.from(deduped.values()).sort((a, b) => b.number - a.number)
      previousCache = state.workItemsCache
      return candidates
    }
  }, [pickerOpen, repoId, number])
  return useAppStore(useShallow(selectCandidates))
}
