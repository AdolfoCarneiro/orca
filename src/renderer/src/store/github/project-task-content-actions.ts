import type { GitHubTaskRead } from './request-coordination'
import type { GitHubProjectTable } from '../../../../shared/github/project-types'
import { githubTaskIdentity } from '@/lib/github-task-target'
import { getGitHubSourceRuntimeTarget } from '@/lib/github-source-runtime-context'
import { projectViewSourceScope } from './cache-identity'

import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'

import { patchGitHubProjectRowContent } from './project-row-actions'
export function createProjectTaskContentAction(
  set: Parameters<StateCreator<AppState>>[0]
): GitHubSlice['patchProjectTaskContent'] {
  return (item, body, source) => {
    const prefix = `github-project:${projectViewSourceScope(getGitHubSourceRuntimeTarget(source))}:`
    const identity = githubTaskIdentity(item)
    set((state) => {
      let next: typeof state.projectViewCache | undefined
      for (const [key, entry] of Object.entries(state.projectViewCache)) {
        if (!key.startsWith(prefix) || !entry.data) {
          continue
        }
        let changed = false
        const rows = entry.data.rows.map((row) => {
          if (
            row.itemType !== 'ISSUE' ||
            !row.content.url ||
            githubTaskIdentity({ url: row.content.url }) !== identity
          ) {
            return row
          }
          changed = true
          const patched = patchGitHubProjectRowContent(row, {
            title: item.title,
            state: item.state,
            labels: item.labels,
            body
          })
          return { ...patched, content: { ...patched.content, assignees: item.assignees ?? [] } }
        })
        if (changed) {
          next ??= { ...state.projectViewCache }
          next[key] = { ...entry, data: { ...entry.data, rows } }
        }
      }
      return next ? { projectViewCache: next } : state
    })
  }
}

export function reconcileProjectTaskRead(
  read: GitHubTaskRead,
  table: GitHubProjectTable,
  current?: GitHubProjectTable | null
): GitHubProjectTable {
  const patches = new Map(read.projectPatches().map((p) => [githubTaskIdentity(p.item), p]))
  if (!patches.size) {
    return table
  }
  const latest = new Map(
    (current?.rows ?? [])
      .filter((r) => r.content.url)
      .map((r) => [githubTaskIdentity({ url: r.content.url! }), r])
  )
  const rows = table.rows.map((row) => {
    if (row.itemType !== 'ISSUE' || !row.content.url) {
      return row
    }
    const identity = githubTaskIdentity({ url: row.content.url })
    const patch = patches.get(identity)
    if (!patch) {
      return row
    }
    const present = latest.get(identity)
    if (present) {
      const { title, body, state, labels, assignees } = present.content
      return { ...row, content: { ...row.content, title, body, state, labels, assignees } }
    }
    const { title, state, labels } = patch.item
    const next = patchGitHubProjectRowContent(row, { title, state, labels, body: patch.body })
    return { ...next, content: { ...next.content, assignees: patch.item.assignees ?? [] } }
  })
  return { ...table, rows }
}
