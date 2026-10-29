import React, { useCallback, useRef, useState, useLayoutEffect } from 'react'

import { useStore } from 'zustand'

import {
  store,
  context,
  HarnessView,
  type OutputRenderer
} from './github-task-refresh.test-fixture'

import { parseTaskQuery } from '../../../shared/task-query'

import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

import { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'

import { useTaskPageGitHubMutationState } from '@/components/task-page/github/use-task-page-github-mutation-state'

import type { TaskPageLinearCreationStateModel } from '@/components/task-page/linear/use-task-page-linear-creation-state'

import type { ListComposition } from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import { patchTaskPageGitHubWorkItemPages } from '@/components/task-page/github/task-page-github-work-item-mutation-pages'

type HarnessProps = { standalone?: boolean; outputs?: OutputRenderer; query?: string }
export function Harness(props: HarnessProps) {
  const [localPages, setPages] = useState(context.pages)
  useStore(store, (state) => state.repos)
  const mutation = useTaskPageGitHubWorkItemMutation({
    queryKey: 'q',
    query: parseTaskQuery(props.query ?? 'is:open'),
    viewerLogin: 'alice',
    patchWorkItem: store.getState().patchWorkItem
  })
  return <HarnessView {...props} localPages={localPages} setPages={setPages} mutation={mutation} />
}
let deferPageUpdates = false
let deferredPageUpdates: React.SetStateAction<(GitHubWorkItem[] | null)[]>[] = []
let commitPages: React.Dispatch<React.SetStateAction<(GitHubWorkItem[] | null)[]>>
export function ProductionHarness(props: HarnessProps) {
  const selectedRepos = useStore(store, (state) => state.repos)
  const [localPages, setLocalPages] = useState(context.pages)
  useLayoutEffect(() => {
    commitPages = setLocalPages
  }, [setLocalPages])
  const setPages = useCallback<typeof setLocalPages>((change) => {
    if (deferPageUpdates) {
      deferredPageUpdates.push(change)
    } else {
      setLocalPages(change)
    }
  }, [])
  const pagesRef = useRef(localPages)
  pagesRef.current = localPages
  const [viewer, setViewer] = useState<string | null>(null)
  const [, setQuiet] = useState(0)
  // SAFETY: the actual mutation owner reads only this declared slice; no lifecycle is mocked.
  const input = {
    selectedRepos,
    taskSource: 'github',
    githubMode: 'items',
    appliedTaskSearch: props.query ?? 'is:open',
    activeTaskPreset: null,
    setQuietRefreshNonce: setQuiet,
    githubViewerLogin: viewer,
    setGitHubViewerLogin: setViewer,
    pages: localPages,
    pagesRef,
    setPages,
    perRepoSourceState: [],
    patchTaskPageWorkItemRows: (
      item: GitHubWorkItem,
      patch: Partial<GitHubWorkItem>,
      matches?: (row: GitHubWorkItem) => boolean,
      listComposition?: readonly ListComposition[]
    ) =>
      setPages((current) =>
        patchTaskPageGitHubWorkItemPages(current, item, patch, matches, listComposition)
      )
  } as TaskPageLinearCreationStateModel
  const owner = useTaskPageGitHubMutationState(input)
  return (
    <HarnessView
      {...props}
      localPages={localPages}
      setPages={setPages}
      mutation={owner.githubWorkItemMutation}
      queryKey={owner.githubWorkItemMutationQueryKey}
      viewerLogin={viewer}
    />
  )
}
export function holdPageUpdates() {
  deferPageUpdates = true
}
export function flushPageUpdates() {
  deferPageUpdates = false
  const queued = deferredPageUpdates
  deferredPageUpdates = []
  commitPages((current) =>
    queued.reduce((rows, update) => (typeof update === 'function' ? update(rows) : update), current)
  )
}

export function resetPageUpdates() {
  deferPageUpdates = false
  deferredPageUpdates = []
}
