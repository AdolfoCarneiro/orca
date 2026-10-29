import '../../orca-runtime-test-mocks.spec'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import {
  openTopologyStoreWithAuthority,
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID
} from '../../../persistence/terminal-topology/terminal-topology-profile-fixture'
import { WindowSession } from '../../../persistence/terminal-topology/terminal-topology-window-session-fixture'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import * as loader from '../../../../shared/workspace-layout/workspace-layout-load'
import * as paneQuery from './pty-pane-query'
import * as surfaceIndex from './terminal-surface-index'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
const leaf = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
const pane = `tab-main-0:${leaf(0)}`

class DefaultPaneRuntime extends OrcaRuntimeService {
  ordinaryFallback = false
  captures = 0
  protected captureTerminalPaneReader(): paneQuery.PtyPaneOf {
    this.captures++
    return this.ordinaryFallback ? (pty) => this.paneOfPty(pty) : super.captureTerminalPaneReader()
  }
  seed(id: string, handle: string): void {
    this.recordPtyWorktree(id, FIXTURE_GIT_WORKTREE_ID, { connected: true })
    this.terminalIdentity.bindPty(id, handle)
    this.terminalIdentity.setHandle(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: FIXTURE_GIT_WORKTREE_ID,
      tabId: `pty:${id}`,
      leafId: `pty:${id}`,
      ptyId: id,
      ptyGeneration: 0
    })
  }
  identityState() {
    return {
      handles: [...this.handles].map(([key, value]) => [key, { ...value, runtimeId: '<runtime>' }]),
      reverse: [...this.handleByPtyId],
      leaves: [...this.leaves],
      incarnations: [...this.handleByPtyIncarnation],
      synthetic: [...this.syntheticTerminalHandles],
      ptys: [...this.ptysById].map(([key, value]) => [key, { ...value }])
    }
  }
}

async function fixture(population: number, ordinary: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pr34890-finite-'))
  const { store } = await openTopologyStoreWithAuthority(directory, emptyTerminalSessionProfile())
  const db = new OrchestrationDb(':memory:')
  const saved = new WindowSession(getDefaultWorkspaceSession())
  for (let i = 0; i < population; i++) {
    saved.addTab(FIXTURE_GIT_WORKTREE_ID, `tab-main-${i}`, leaf(i))
    saved.bind(`tab-main-${i}`, leaf(i), `pty-main-${i}`)
  }
  store.setWorkspaceSession(saved.snapshot(), 'local')
  await store.flushPendingOrThrowAsync()
  const runtime = new DefaultPaneRuntime(store)
  runtime.ordinaryFallback = ordinary
  runtime.setOrchestrationDb(db)
  runtime.seed('coord', 'term_coord')
  for (let i = 0; i < population; i++) {
    runtime.seed(`pty-main-${i}`, `term_main_${i}`)
  }
  runtime.seed('replacement', 'term_replacement')
  const run = db.createRun({
    objective: 'Finite acquisition',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'coord-pane'
  })
  const task = db.createTask({ runId: run.id, spec: 'Main worker' })
  const dispatch = db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'term_missing_stored',
    assigneePaneKey: pane,
    creator: { kind: 'system' },
    maxDepth: 10
  })
  const stop = runtime.watchOrchestrationCrew(() => {})
  const rebind = async () => {
    const next = structuredClone(store.getWorkspaceSession())
    next.terminalLayoutsByTabId['tab-main-0'].ptyIdsByLeafId = { [leaf(0)]: 'replacement' }
    store.setWorkspaceSession(next, 'local')
    await store.flushPendingOrThrowAsync()
  }
  return {
    runtime,
    rebind,
    normalize: (value: unknown) =>
      JSON.stringify(value)
        .replaceAll(run.id, '<run>')
        .replaceAll(task.id, '<task>')
        .replaceAll(dispatch.id, '<dispatch>')
        .replaceAll(runtime.runtimeId, '<runtime>'),
    close: async () => {
      stop()
      db.close()
      await store.freezeWritesAsync()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

it('bounds the real public default fallback separately from captured Crew and preserves full outputs and identity effects', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
  try {
    for (const population of [3, 30]) {
      const baseline = await fixture(population, true)
      const candidate = await fixture(population, false)
      try {
        const loads = vi.spyOn(loader, 'loadWorkspaceLayoutWithoutReport')
        const capture = vi.spyOn(paneQuery, 'captureMainTerminalPaneLookup')
        const qualify = vi.spyOn(surfaceIndex, 'terminalHoldsPane')
        const measure = (read: () => unknown) => {
          loads.mockClear()
          capture.mockClear()
          qualify.mockClear()
          const value = read()
          return {
            value,
            loads: loads.mock.calls.length,
            surfaceCandidates: capture.mock.calls.reduce(
              (sum, [surfaces]) => sum + surfaces.leaves.length,
              0
            ),
            factCopies: capture.mock.calls.reduce(
              (sum, [surfaces]) => sum + surfaces.paneFacts.size,
              0
            ),
            qualificationCalls: qualify.mock.calls.length
          }
        }
        for (const f of [baseline, candidate]) {
          expect(f.runtime.getTerminalHandleForPaneKey(pane)).toBe('term_main_0')
          f.runtime.getOrchestrationCrewSnapshot('term_coord')
          await f.rebind()
        }
        const old = measure(() => baseline.runtime.getTerminalHandleForPaneKey(pane))
        const next = measure(() => candidate.runtime.getTerminalHandleForPaneKey(pane))
        expect(next.value).toBe(old.value)
        expect(next.value).toBe('term_replacement')
        expect(old.loads).toBe(population + 3)
        expect(next.loads).toBe(2)
        expect(next.surfaceCandidates).toBe(population)
        expect(next.factCopies).toBe(population)
        expect(next.qualificationCalls).toBeLessThanOrEqual(population + 3)
        expect(candidate.runtime.identityState()).toEqual(baseline.runtime.identityState())
        baseline.runtime.ordinaryFallback = false
        const oldCrew = measure(() => baseline.runtime.getOrchestrationCrewSnapshot('term_coord'))
        const nextCrew = measure(() => candidate.runtime.getOrchestrationCrewSnapshot('term_coord'))
        expect(candidate.normalize(nextCrew.value)).toBe(baseline.normalize(oldCrew.value))
        expect(nextCrew.loads).toBe(1)
        expect(nextCrew.surfaceCandidates).toBe(population)
        expect(candidate.runtime.identityState()).toEqual(baseline.runtime.identityState())
        console.log('finite public acquisition receipt', {
          population,
          old,
          next,
          oldCrew,
          nextCrew
        })
        loads.mockRestore()
        capture.mockRestore()
        qualify.mockRestore()
      } finally {
        await candidate.close()
        await baseline.close()
      }
    }
  } finally {
    vi.useRealTimers()
  }
})

it('keeps absent and exact/reminted connected public points outside global capture', () => {
  const runtime = new DefaultPaneRuntime(null)
  expect(runtime.getTerminalHandleForPaneKey(pane)).toBeNull()
  expect(runtime.captures).toBe(0)
  runtime.seed('fast', 'term_fast')
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-main-0',
        worktreeId: FIXTURE_GIT_WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: leaf(0),
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-main-0',
        worktreeId: FIXTURE_GIT_WORKTREE_ID,
        leafId: leaf(0),
        ptyId: 'fast',
        paneRuntimeId: 1
      }
    ]
  })
  const before = runtime.captures
  expect(runtime.getTerminalHandleForPaneKey(pane)).toBe('term_fast')
  expect(runtime.getTerminalHandleForPaneKey(`tab-moved:${leaf(0)}`)).toBe('term_fast')
  expect(runtime.captures).toBe(before)
})
