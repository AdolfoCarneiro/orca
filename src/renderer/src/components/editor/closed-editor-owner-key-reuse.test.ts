// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  createModelLifetimeFixture,
  resetModelLifetimeFixtures,
  modelLifetimeFile
} from './editor-model-lifetime-fixture'
import { getEditorModelOwnerKey } from './editor-model-owner'
import type * as EditorModelOwner from './editor-model-owner'
import { createEditorModelOwnerKeyCache } from './editor-model-owner-key-cache'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('./editor-model-owner', async (importOriginal) => {
  const original = await importOriginal<typeof EditorModelOwner>()
  return { ...original, getEditorModelOwnerKey: vi.fn(original.getEditorModelOwnerKey) }
})
afterEach(resetModelLifetimeFixtures)

it('re-resolves only the changed tab until an owner input changes', async () => {
  const { store, attach, add } = createModelLifetimeFixture()
  const tabs = Array.from({ length: 20 }, (_, index) => add(`tab-${index}`))
  attach()
  const resolve = vi.mocked(getEditorModelOwnerKey)
  const markDirty = (id: string): void =>
    store.setState({
      openFiles: store
        .getState()
        .openFiles.map((file) => (file.id === id ? { ...file, isDirty: !file.isDirty } : file))
    })

  markDirty('tab-0')
  resolve.mockClear()
  markDirty('tab-1')
  expect(resolve).toHaveBeenCalledTimes(1)

  resolve.mockClear()
  store.setState({ runtimeEnvironments: [] })
  expect(resolve).toHaveBeenCalledTimes(tabs.length)

  store.getState().closeFile('tab-3')
  await Promise.resolve()
  expect(tabs[3].model.isDisposed()).toBe(true)
  expect(tabs[4].model.isDisposed()).toBe(false)
})

it('resolves no owners for rank-only worktree patches but does for owner changes', () => {
  const { store, attach, add } = createModelLifetimeFixture()
  add('ranked')
  attach()
  const resolve = vi.mocked(getEditorModelOwnerKey)
  const patchRows = (patch: { sortOrder?: number; hostId?: 'runtime:env' }): void => {
    const rows = store.getState().worktreesByRepo['model-fixture']
    store.setState({
      worktreesByRepo: { 'model-fixture': rows.map((row) => ({ ...row, ...patch })) }
    })
  }

  resolve.mockClear()
  patchRows({ sortOrder: 7 })
  expect(resolve).not.toHaveBeenCalled()

  patchRows({ hostId: 'runtime:env' })
  expect(resolve).toHaveBeenCalled()
})

it('keeps superseded owner readers isolated from the current owner cache', () => {
  const { store } = createModelLifetimeFixture(false)
  const file = modelLifetimeFile('superseded')
  const local = store.getState()
  const remote = {
    ...local,
    worktreesByRepo: {
      'model-fixture': local.worktreesByRepo['model-fixture'].map((row) => ({
        ...row,
        hostId: 'ssh:server-a' as const
      }))
    }
  }
  const cache = createEditorModelOwnerKeyCache(local)
  expect(cache.ownerKeyOf(file, local)).toBe('')
  const formerReader = cache.ownerKeyReaderFor(local)
  const remoteKey = JSON.stringify([null, 'ssh:server-a'])
  expect(cache.ownerKeyOf(file, remote)).toBe(remoteKey)
  const resolve = vi.mocked(getEditorModelOwnerKey)
  resolve.mockClear()
  expect(formerReader(file)).toBe('')
  expect(resolve).not.toHaveBeenCalled()

  const supersededReader = cache.ownerKeyReaderFor(local)
  expect(supersededReader(file)).toBe('')
  expect(resolve).toHaveBeenCalledTimes(1)
  resolve.mockClear()
  const focusedRemote = { ...remote, activeFileId: file.id }
  expect(cache.ownerKeyOf(file, focusedRemote)).toBe(remoteKey)
  expect(resolve).not.toHaveBeenCalled()
})
