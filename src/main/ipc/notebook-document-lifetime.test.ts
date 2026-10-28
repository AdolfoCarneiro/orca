import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { KernelFrame } from '../../shared/notebook-kernel-types'

const { handlers, authorize, startKernel } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  authorize: vi.fn(async (filePath: string) => filePath),
  startKernel: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('./local-file-access-resolution', () => ({
  resolveUserNamedRegularFile: authorize,
  resolveDesktopAuthorizedPath: authorize
}))
vi.mock('node:fs/promises', () => ({ realpath: async (filePath: string) => filePath }))
vi.mock('../notebook/notebook-kernel', () => ({ startNotebookKernel: startKernel }))

import { registerNotebookHandlers } from './notebook'

const owners: EventEmitter[] = []
let ownerSequence = 0

function createOwner() {
  const owner = Object.assign(new EventEmitter(), {
    id: ++ownerSequence,
    mainFrame: { processId: 1, routingId: ownerSequence },
    isDestroyed: () => false,
    send: vi.fn()
  })
  owners.push(owner)
  return owner
}

function failReplacement(owner: ReturnType<typeof createOwner>): void {
  owner.mainFrame.routingId++
  owner.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://orca.test/', true)
}

function kernelFixture(ready = Promise.resolve({ status: 'ready' as const })) {
  let emit = (_frame: KernelFrame): void => {}
  const exited = Promise.withResolvers<void>()
  const kernel = { execute: vi.fn(), interrupt: vi.fn(), shutdown: vi.fn() }
  startKernel.mockImplementationOnce((options: { onFrame: (frame: KernelFrame) => void }) => {
    emit = options.onFrame
    return { kernel, ready, exited: exited.promise }
  })
  return { kernel, emit: (frame: KernelFrame) => emit(frame), exit: () => exited.resolve() }
}

function invoke(channel: string, owner: ReturnType<typeof createOwner>, filePath: string) {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`Missing ${channel}`)
  }
  return handler({ sender: owner }, { filePath, python: '/python', code: 'current' })
}

beforeEach(() => {
  handlers.clear()
  authorize.mockReset().mockImplementation(async (filePath: string) => filePath)
  startKernel.mockReset()
  // SAFETY: The mocked authorizer is the only store consumer on the exercised handler paths.
  registerNotebookHandlers({} as Store)
})

afterEach(() => {
  for (const owner of owners) {
    owner.emit('destroyed')
  }
  owners.length = 0
})

it.each([1, 10])(
  'retires %s ready kernels and ignores late output after error replacement',
  async (count) => {
    const owner = createOwner()
    const kernels = Array.from({ length: count }, () => kernelFixture())
    for (let i = 0; i < count; i++) {
      await invoke('notebook:startKernel', owner, `/notes/${i}.ipynb`)
    }
    failReplacement(owner)
    for (const entry of kernels) {
      expect(entry.kernel.shutdown).toHaveBeenCalledOnce()
      entry.emit({ type: 'done', status: 'ok', execution_count: 1 })
    }
    expect(owner.send).not.toHaveBeenCalled()
    expect(owner.eventNames()).toEqual([])
  }
)

it('rearms successive documents without letting old exits or frames affect a sibling or successor', async () => {
  const owner = createOwner()
  const sibling = createOwner()
  const original = kernelFixture()
  const other = kernelFixture()
  await invoke('notebook:startKernel', owner, '/notes/same.ipynb')
  await invoke('notebook:startKernel', sibling, '/notes/same.ipynb')
  for (let generation = 0; generation < 3; generation++) {
    failReplacement(owner)
    const current = kernelFixture()
    await invoke('notebook:startKernel', owner, '/notes/same.ipynb')
    original.exit()
    await Promise.resolve()
    original.emit({ type: 'done', status: 'ok', execution_count: 1 })
    invoke('notebook:execute', owner, '/notes/same.ipynb')
    expect(current.kernel.execute).toHaveBeenCalledWith('current')
    expect(current.kernel.shutdown).not.toHaveBeenCalled()
    expect(owner.send).not.toHaveBeenCalled()
    current.emit({ type: 'done', status: 'ok', execution_count: generation })
    expect(owner.send).toHaveBeenCalledOnce()
    owner.send.mockClear()
  }
  expect(original.kernel.shutdown).toHaveBeenCalledOnce()
  expect(other.kernel.shutdown).not.toHaveBeenCalled()
  other.emit({ type: 'done', status: 'ok', execution_count: 1 })
  expect(sibling.send).toHaveBeenCalledOnce()
})

it.each(['provisional', 'cancelled', 'invalid-url', 'subframe', 'same-document'])(
  'preserves the live kernel after %s navigation',
  async (kind) => {
    const owner = createOwner()
    const entry = kernelFixture()
    await invoke('notebook:startKernel', owner, '/notes/live.ipynb')
    if (kind === 'same-document') {
      owner.emit('did-navigate-in-page', {}, 'file:///notes#same', true)
    } else {
      owner.emit(
        'did-fail-load',
        {},
        kind === 'invalid-url' ? -300 : -3,
        'failed',
        'http://invalid',
        kind !== 'subframe'
      )
    }
    entry.emit({ type: 'done', status: 'ok', execution_count: 1 })
    expect(entry.kernel.shutdown).not.toHaveBeenCalled()
    expect(owner.send).toHaveBeenCalledOnce()
  }
)

it('cancels a start still awaiting authorization after error replacement', async () => {
  const owner = createOwner()
  const authorization = Promise.withResolvers<string>()
  authorize.mockReturnValueOnce(authorization.promise)
  const pending = invoke('notebook:startKernel', owner, '/notes/pending.ipynb')
  failReplacement(owner)
  authorization.resolve('/notes/pending.ipynb')
  await expect(pending).resolves.toMatchObject({ status: 'failed' })
  expect(startKernel).not.toHaveBeenCalled()
})

it('shuts down an already spawned kernel while readiness is pending', async () => {
  const owner = createOwner()
  const ready = Promise.withResolvers<{ status: 'ready' }>()
  const entry = kernelFixture(ready.promise)
  const pending = invoke('notebook:startKernel', owner, '/notes/starting.ipynb')
  await vi.waitFor(() => expect(startKernel).toHaveBeenCalledOnce())
  failReplacement(owner)
  expect(entry.kernel.shutdown).toHaveBeenCalledOnce()
  ready.resolve({ status: 'ready' })
  await pending
  entry.emit({ type: 'done', status: 'ok', execution_count: 1 })
  expect(owner.send).not.toHaveBeenCalled()
  expect(owner.eventNames()).toEqual([])
})
