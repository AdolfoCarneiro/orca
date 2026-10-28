// @vitest-environment happy-dom
import { createStore } from 'zustand/vanilla'
import { afterEach, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { EditorBufferRouteState } from '@/store/slices/editor/buffers/editor-buffer-identity-cache'
import { createEditorModelRegistry } from '@/lib/editor-model-registry'
import { attachClosedEditorTabCleanup } from './closed-editor-tab-controller'
import { createEditorModelOwnerKeyCache } from './editor-model-owner-key-cache'
import * as EditorModelOwner from './editor-model-owner'
import {
  createModelLifetimeFixture,
  resetModelLifetimeFixtures,
  modelLifetimeFile,
  modelLifetimeEditorModel
} from './editor-model-lifetime-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
afterEach(() => {
  vi.restoreAllMocks()
  resetModelLifetimeFixtures()
})

type EditorState = EditorBufferRouteState & {
  openFiles: OpenFile[]
  editorDrafts: Record<string, string>
}

const file: OpenFile = {
  id: 'editor-memory-file',
  filePath: '/workspace/document.txt',
  relativePath: 'document.txt',
  worktreeId: 'fixture',
  language: 'plaintext',
  mode: 'edit',
  isDirty: false
}

function closeLastEditor(source: 'initial' | 'updated') {
  const store = createStore<EditorState>(() => ({
    openFiles: [],
    editorDrafts: {},
    worktreesByRepo: { fixture: [{ id: 'fixture', repoId: 'fixture', hostId: 'local' }] }
  }))
  const open = () =>
    store.setState({ openFiles: [file], editorDrafts: { [file.id]: 'discarded document text' } })
  if (source === 'initial') {
    open()
  }
  const stop = attachClosedEditorTabCleanup(store, createEditorModelRegistry())
  if (source === 'updated') {
    open()
    store.setState({ openFiles: [{ ...file, isDirty: true }] })
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
  'releases the %s editor snapshot while closed-tab cleanup remains subscribed',
  async (source) => {
    const { store, stop, retired } = closeLastEditor(source)
    try {
      await collectRetiredState()
      expect(retired.snapshot.deref()).toBeUndefined()
      expect(retired.drafts.deref()).toBeUndefined()
      expect(store.getState().openFiles).toEqual([])
      expect(store.getState().editorDrafts).toEqual({})
    } finally {
      stop()
    }
  }
)

it('resolves keys after collection and isolates subsequent host and buffer ownership changes', async () => {
  function prime() {
    const snapshot: EditorState = {
      openFiles: [file],
      editorDrafts: { [file.id]: 'retired draft' },
      worktreesByRepo: { fixture: [{ id: 'fixture', repoId: 'fixture', hostId: 'local' }] }
    }
    const cache = createEditorModelOwnerKeyCache(snapshot)
    expect(cache.ownerKeyOf(file, snapshot)).toBe('')
    return { cache, retired: new WeakRef(snapshot) }
  }
  const { cache, retired } = prime()
  await collectRetiredState()
  expect(retired.deref()).toBeUndefined()

  const local: EditorState = {
    openFiles: [file],
    editorDrafts: {},
    worktreesByRepo: { fixture: [{ id: 'fixture', repoId: 'fixture', hostId: 'local' }] }
  }
  expect(cache.ownerKeyReaderFor(local)(file)).toBe('')
  expect(cache.ownerKeyOf(file, local)).toBe('')
  const remote: EditorState = {
    ...local,
    worktreesByRepo: {
      fixture: [{ id: 'fixture', repoId: 'fixture', hostId: 'ssh:server-a' }]
    }
  }
  const remoteKey = JSON.stringify([null, 'ssh:server-a'])
  expect(cache.ownerKeyOf(file, remote)).toBe(remoteKey)
  expect(cache.ownerKeyReaderFor(local)(file)).toBe('')
  expect(cache.ownerKeyOf(file, remote)).toBe(remoteKey)
  const detached = { ...remote, editorBufferIdOf: { [file.id]: 'detached:private-record' } }
  expect(cache.ownerKeyOf(file, detached)).toBe(
    JSON.stringify(['detached', 'detached:private-record', remoteKey])
  )
})

it.each([20, 200])(
  'reuses owner keys after unrelated state and GC with %s tabs',
  async (tabCount) => {
    const { store, attach } = createModelLifetimeFixture()
    const files = Array.from({ length: tabCount }, (_, index) => modelLifetimeFile(`gc-${index}`))
    const closedModel = modelLifetimeEditorModel(files[3].filePath)
    const liveModel = modelLifetimeEditorModel(files[4].filePath)
    store.setState({ openFiles: files })
    attach()
    const markDirty = (id: string): void =>
      store.setState({
        openFiles: store
          .getState()
          .openFiles.map((file) => (file.id === id ? { ...file, isDirty: !file.isDirty } : file))
      })
    const resolve = vi.spyOn(EditorModelOwner, 'getEditorModelOwnerKey')
    markDirty(files[0].id)
    resolve.mockClear()
    markDirty(files[1].id)
    expect(resolve).toHaveBeenCalledTimes(1)

    const retired = new WeakRef(store.getState())
    store.getState().setActiveFile(files[2].id)
    resolve.mockClear()
    await collectRetiredState()
    expect(retired.deref()).toBeUndefined()

    resolve.mockClear()
    markDirty(files[2].id)
    const afterGcCalls = resolve.mock.calls.length
    store.getState().closeFile(files[3].id)
    await Promise.resolve()
    expect(closedModel.isDisposed()).toBe(true)
    expect(liveModel.isDisposed()).toBe(false)
    expect(afterGcCalls).toBe(1)
  }
)
