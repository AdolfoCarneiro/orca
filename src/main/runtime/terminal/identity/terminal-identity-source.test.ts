import { afterEach, expect, it, vi } from 'vitest'
import { identityFixture, LEAF, PANE } from '../query/terminal-identity.test-fixture'
import {
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  TEST_WORKTREE_ID
} from '../../orca-runtime-test-fixtures.spec'
import { recordPtySurface, forgetPtySurface } from '../../pty-recorded-surface-topology'
import { RUNTIME_GRAPH_RELOAD_TIMEOUT_MS } from '../../runtime-graph-reload-lifecycle'
import type { RuntimeSyncWindowGraph } from '../../../../shared/runtime-types'
import type { TerminalLeafMoveResult } from '../../../../shared/terminal-leaf-move'

const graph = (ptyId: string): RuntimeSyncWindowGraph => ({
  tabs: [
    {
      tabId: 'tab-original',
      worktreeId: TEST_WORKTREE_ID,
      title: 'Terminal',
      activeLeafId: LEAF,
      layout: null
    }
  ],
  leaves: [
    { tabId: 'tab-original', worktreeId: TEST_WORKTREE_ID, leafId: LEAF, paneRuntimeId: 1, ptyId }
  ]
})

afterEach(() => vi.useRealTimers())

it('owns consumed creation aliases while preserving canonical output and retained graph leaf references', () => {
  const f = identityFixture()
  const original = f.owner.recordPtyWorktree('pty-owned', TEST_WORKTREE_ID)
  const input = { ...original }
  const canonical = f.owner.source.createPty(input)
  input.connected = false
  input.paneKey = 'borrowed-alias'
  input.incarnationId = 'borrowed-process'
  expect(canonical.connected).toBe(true)
  expect(canonical.paneKey).not.toBe('borrowed-alias')
  expect(canonical.incarnationId).toBeNull()
  expect(canonical.tailBuffer).toBe(input.tailBuffer)

  f.runtime.attachWindow(1)
  const publication = graph('pty-owned')
  f.runtime.syncWindowGraph(1, publication)
  const leaf = f.owner.leaves.get(`tab-original::${LEAF}`)!
  expect(f.owner.getLeavesForPty('pty-owned')[0]).toBe(leaf)
  publication.leaves[0]!.ptyId = 'external-replacement'
  publication.tabs[0]!.worktreeId = 'external-workspace'
  expect(leaf.ptyId).toBe('pty-owned')
  expect(f.runtime.getTerminalWorktreeIdForHandle(f.owner.issueHandle(leaf))).toBe(TEST_WORKTREE_ID)
  f.owner.source.replaceLeaves(f.owner.leaves)
  expect(f.owner.getLeavesForPty('pty-owned')[0]).toBe(leaf)
  f.runtime.onPtyData('pty-owned', 'canonical output\r\n', 500)
  expect(f.owner.ptysById.get('pty-owned')).toBe(canonical)
  expect(f.owner.getLeavesForPty('pty-owned')[0]).toBe(leaf)
  expect(leaf.preview).toContain('canonical output')

  const handleInput = { ...f.owner.handles.get(f.owner.issueHandle(leaf))! }
  f.owner.source.setHandle(handleInput.handle, handleInput)
  handleInput.ptyId = 'external-handle-write'
  expect(f.owner.handles.get(handleInput.handle)?.ptyId).toBe('pty-owned')
  const incarnationInput = {
    handle: handleInput.handle,
    incarnationId: 'process',
    leafKey: 'original'
  }
  f.owner.source.setIncarnation('pty-owned', incarnationInput)
  incarnationInput.leafKey = 'external-incarnation-write'
  expect(f.owner.handleByPtyIncarnation.get('pty-owned')?.leafKey).toBe('original')
})

it('retires before dependent callbacks, keeps connected output idle and preserves partial writes when a callback fails', () => {
  const f = identityFixture()
  const pty = f.owner.recordPtyWorktree('pty-owned', TEST_WORKTREE_ID)
  const changes: (string | null | undefined)[] = []
  const stop = f.owner.crewChanges.subscribe(() => changes.push(pty.paneKey))
  recordPtySurface(f.owner.source, pty, 'tab-original', PANE, 3)
  expect(changes).toEqual([PANE])
  recordPtySurface(f.owner.source, pty, 'tab-original', PANE, 2)
  expect(changes).toEqual([PANE])
  f.owner.source.replaceLeaves(f.owner.leaves)
  f.owner.source.bindPty('pty-owned', 'term_owned')
  const before = changes.length
  f.owner.source.bindPty('pty-owned', 'term_owned')
  for (let i = 0; i < 30; i++) {
    f.runtime.onPtyData('pty-owned', 'output', 500 + i)
  }
  expect(changes).toHaveLength(before)
  const fail = f.owner.crewChanges.subscribe(() => {
    throw new Error('consumer_failure')
  })
  expect(() => forgetPtySurface(f.owner.source, pty)).not.toThrow()
  expect(pty.paneKey).toBeNull()
  expect(changes.at(-1)).toBeNull()
  fail()
  expect(() => {
    recordPtySurface(f.owner.source, pty, 'tab-original', PANE, 4)
    throw new Error('later_operation_failure')
  }).toThrow('later_operation_failure')
  expect(changes.at(-1)).toBe(PANE)
  stop()
})

it('wakes for preallocation before any leaf or incarnation and for a real pane move only after its awaited commit', async () => {
  const harness = makeRuntimeStoreWithWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
  const f = identityFixture(undefined, harness.runtimeStore)
  const wake = vi.fn()
  const stop = f.owner.crewChanges.subscribe(wake)
  const old = f.runtime.createTerminalIdentityReadContext()
  expect(f.owner.getLivePtyForHandle('absent', old)).toBeNull()
  const handle = f.runtime.preAllocateHandleForPty('pty-owned')
  expect(wake).toHaveBeenCalledTimes(1)
  expect(f.owner.handleByPtyId.get('pty-owned')).toBe(handle)
  expect(f.owner.leaves.size).toBe(0)
  expect(f.owner.handleByPtyIncarnation.size).toBe(0)
  f.runtime.onPtySpawned('pty-owned')
  const pty = f.owner.recordPtyWorktree('pty-owned', TEST_WORKTREE_ID, { paneKey: PANE })
  let finish: ((result: TerminalLeafMoveResult) => void) | undefined
  const commit = vi.fn(
    () =>
      new Promise<TerminalLeafMoveResult>((resolve) => {
        finish = resolve
      })
  )
  const move = f.runtime.moveMobileSessionLeafToNewTab(
    `id:${TEST_WORKTREE_ID}`,
    {
      sourceTabId: 'tab-original',
      targetTabId: 'tab-moved',
      leafId: LEAF
    },
    commit
  )
  expect(commit).toHaveBeenCalledOnce()
  const before = wake.mock.calls.length
  expect(pty.paneKey).toBe(PANE)
  const warmed = f.runtime.createTerminalIdentityReadContext()
  f.owner.getPtyRecordForPaneKey(`tab-moved:${LEAF}`, warmed)
  if (!finish) {
    throw new Error('Expected the production move to await commit')
  }
  finish({ status: 'moved', ptyId: 'pty-owned' })
  await expect(move).resolves.toEqual({ status: 'moved', ptyId: 'pty-owned' })
  expect(pty.paneKey).toBe(`tab-moved:${LEAF}`)
  expect(wake.mock.calls.length).toBeGreaterThan(before)
  expect(
    f.owner.getPtyRecordForPaneKey(
      `tab-moved:${LEAF}`,
      f.runtime.createTerminalIdentityReadContext()
    )
  ).toBe(f.owner.getPtyRecordForPaneKey(`tab-moved:${LEAF}`))
  stop()
})

it('retires real rollback with no snapshot and reload timeout with no browser publication', async () => {
  vi.useFakeTimers()
  const f = identityFixture()
  f.add('pty-owned', 'term_owned', PANE)
  f.runtime.attachWindow(1)
  f.runtime.syncWindowGraph(1, graph('pty-owned'))
  f.owner.issueHandle(f.owner.leaves.get(`tab-original::${LEAF}`)!)
  const wake = vi.fn()
  const stop = f.owner.crewChanges.subscribe(wake)
  f.owner.rollbackLegacy({
    dispatchId: 'dispatch',
    dispatchStatus: 'dispatched',
    contractVersion: 1,
    taskId: 'task',
    worktreeId: TEST_WORKTREE_ID,
    terminalHandle: 'term_owned',
    paneKey: PANE,
    tabId: 'tab-original',
    leafId: LEAF,
    processIncarnation: 'pty-owned:process',
    ptyId: 'pty-owned',
    incarnationId: 'process'
  })
  expect(f.owner.leaves.size).toBe(0)
  expect(f.owner.ptysById.get('pty-owned')?.paneKey).toBeNull()
  expect(wake).toHaveBeenCalled()
  f.runtime.syncWindowGraph(1, graph('pty-owned'))
  f.owner.beginGraphReload(1)
  const before = wake.mock.calls.length
  await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS)
  expect(f.owner.leaves.size).toBe(0)
  expect(f.owner.handles.size).toBe(0)
  expect(wake.mock.calls.length).toBeGreaterThan(before)
  expect(() => f.runtime.assertGraphReady()).toThrow('runtime_unavailable')
  stop()
})
