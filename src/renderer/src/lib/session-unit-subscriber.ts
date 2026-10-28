import type { AppState } from '../store/types'
import {
  SESSION_SOURCE_FIELDS,
  discoverSessionSources,
  type SessionSourceField
} from './session-source-discovery'
import { shouldPersistWorkspaceSession } from './workspace-session'
import { SessionUnitProjection } from './session-unit-projection'
import type { SessionUnitWriter } from './session-unit-writer'

export function createSessionUnitSubscriber({
  store,
  writer,
  debounceMs = 150,
  onPersistError
}: {
  store: { getState(): AppState; subscribe(listener: (state: AppState) => void): () => void }
  writer: SessionUnitWriter
  debounceMs?: number
  onPersistError?: (error: unknown) => void
}): () => void {
  let observed = store.getState()
  let discovered = observed
  let projection: SessionUnitProjection | undefined
  let full = true
  let retry = false
  let writing = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = new Set<SessionSourceField>()
  const arm = (): void => {
    if (disposed || writing || timer || !shouldPersistWorkspaceSession(store.getState())) {
      return
    }
    timer = setTimeout(flush, debounceMs)
  }
  const flush = (): void => {
    timer = undefined
    if (
      disposed ||
      writing ||
      !shouldPersistWorkspaceSession(store.getState()) ||
      (!full && !retry && !pending.size)
    ) {
      return
    }
    const state = store.getState()
    const fields = pending
    pending = new Set()
    projection ??= new SessionUnitProjection(state)
    const update = full
      ? projection.full(state)
      : projection.update(state, discoverSessionSources(discovered, state, fields))
    discovered = state
    full = false
    retry = false
    writing = true
    void writer.write(update, state).then(
      () => {
        writing = false
        if (pending.size || full) {
          arm()
        }
      },
      (error: unknown) => {
        writing = false
        retry = true
        onPersistError?.(error)
      }
    )
  }
  const unsubscribe = store.subscribe((state) => {
    let changed = false
    for (const field of SESSION_SOURCE_FIELDS) {
      if (observed[field] !== state[field]) {
        pending.add(field)
        changed = true
      }
    }
    observed = state
    if (changed && timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (pending.size || full || retry) {
      arm()
    }
  })
  arm()
  return () => {
    disposed = true
    writer.dispose()
    unsubscribe()
    if (timer) {
      clearTimeout(timer)
    }
    pending.clear()
  }
}
