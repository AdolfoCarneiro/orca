import type { GitHubProjectRow } from '../../../shared/github/project-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { githubTaskWriteKey } from './github-task-target'
export { githubTaskWriteKey as githubWorkItemWriteKey } from './github-task-target'

const writes = new Set<{ key: string; completion: Promise<unknown> }>()
const starts = new Set<(key: string) => void>()

export function startGitHubWorkItemWrite(key: string): () => void {
  let complete = () => {}
  const write = {
    key,
    completion: new Promise<void>((resolve) => {
      complete = resolve
    })
  }
  writes.add(write)
  for (const listener of starts) {
    listener(key)
  }
  return () => {
    writes.delete(write)
    complete()
  }
}
export async function withGitHubWorkItemWrite<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const finish = startGitHubWorkItemWrite(key)
  try {
    return await operation()
  } finally {
    finish()
  }
}

/** Observe only while one explicit request is alive; completed writes retain no bookkeeping. */
export function observeGitHubWorkItemWrites(key: string, onStart?: () => void) {
  let changed = false
  const listener = (started: string) => {
    if (started === key) {
      changed = true
      onStart?.()
    }
  }
  starts.add(listener)
  return {
    changed: () => changed,
    async wait() {
      for (;;) {
        const pending = [...writes].filter((write) => write.key === key)
        if (pending.length === 0) {
          changed = false
          return
        }
        await Promise.all(pending.map((write) => write.completion))
      }
    },
    dispose: () => {
      starts.delete(listener)
    }
  }
}

export function observeGitHubProjectWrite<T>(
  invoke: (start: (row: GitHubProjectRow, target: RuntimeClientTarget) => void) => Promise<T>
): Promise<T> {
  let finish = () => {}
  try {
    return invoke((row, target) => {
      if (row.itemType === 'ISSUE' && row.content.url) {
        finish = startGitHubWorkItemWrite(
          githubTaskWriteKey(
            { url: row.content.url },
            target.kind === 'environment'
              ? {
                  kind: 'task-source',
                  provider: 'github',
                  hostId: `runtime:${target.environmentId}`,
                  projectId: '',
                  repoId: null
                }
              : null
          )
        )
      }
    }).finally(() => finish())
  } catch (error) {
    finish()
    throw error
  }
}
