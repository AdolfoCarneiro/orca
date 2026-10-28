import { expect, it } from 'vitest'
import { createTestStore, makeOpenFile } from '../store/slices/store-test-helpers'
import {
  framesDrawWorkspace,
  onWorkspaceStartsDrawing
} from './workspace-layout-frame-drawn-workspaces'

const WORKSPACE = 'folder:/workspace'

function retireDrafts(baseline: 'initial' | 'updated') {
  const store = createTestStore()
  const fill = () =>
    store.setState({
      groupsByWorktree: { [WORKSPACE]: [] },
      openFiles: [makeOpenFile({ id: 'document', worktreeId: WORKSPACE, isDirty: true })],
      editorDrafts: { document: 'discarded editor content' }
    })
  if (baseline === 'initial') {
    fill()
  }
  const stop = onWorkspaceStartsDrawing(
    store,
    framesDrawWorkspace,
    () => [WORKSPACE],
    () => {}
  )
  if (baseline === 'updated') {
    fill()
  }
  const snapshot = store.getState()
  const retired = { snapshot: new WeakRef(snapshot), drafts: new WeakRef(snapshot.editorDrafts) }
  store.setState({ openFiles: [], editorDrafts: {} })
  return { store, stop, retired }
}

async function collectRetiredState(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

it.each(['initial', 'updated'] as const)(
  'releases the %s snapshot while frame drawing remains subscribed',
  async (baseline) => {
    const { store, stop, retired } = retireDrafts(baseline)
    try {
      await collectRetiredState()
      expect(retired.snapshot.deref()).toBeUndefined()
      expect(retired.drafts.deref()).toBeUndefined()
      expect(store.getState().editorDrafts).toEqual({})
      expect(framesDrawWorkspace(store.getState())(WORKSPACE)).toBe(true)
    } finally {
      stop()
    }
  }
)

it('keeps first visits, both catalog gates, reentrant writes and disposal working', () => {
  const store = createTestStore()
  let drawChecks = 0
  let drawn = 0
  let unshown = [WORKSPACE]
  const stop = onWorkspaceStartsDrawing(
    store,
    (state) => {
      drawChecks += 1
      return framesDrawWorkspace(state)
    },
    () => unshown,
    () => {
      drawn += 1
      store.setState({ editorDrafts: {} })
    }
  )
  try {
    store.setState({ editorDrafts: {} })
    expect(drawChecks).toBe(0)
    store.setState({ groupsByWorktree: { [WORKSPACE]: [] } })
    expect(drawn).toBe(1)
    store.setState({ unifiedTabsByWorktree: { [WORKSPACE]: [] } })
    expect(drawn).toBe(2)
    unshown = []
    store.setState({ groupsByWorktree: {} })
    expect(drawn).toBe(2)
    unshown = [WORKSPACE]
    store.setState({ unifiedTabsByWorktree: {} })
    expect(drawn).toBe(2)
    expect(drawChecks).toBe(4)
  } finally {
    stop()
  }
  store.setState({ groupsByWorktree: { [WORKSPACE]: [] } })
  expect(drawChecks).toBe(4)
  expect(drawn).toBe(2)
})
