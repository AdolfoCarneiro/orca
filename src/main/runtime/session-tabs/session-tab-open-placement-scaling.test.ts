// Production snapshot storage and frame overlays execute; only external workspace/process I/O uses the existing fixture.
import { expect, it, vi } from 'vitest'
import * as placementProjection from './session-tab-open-placement'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import { applyWorkspaceLayoutRecordChange } from '../../../shared/workspace-layout/workspace-layout-records'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID,
  LEAF_A,
  PTY_A
} from '../main-owned-workspace-runtime-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

/** Count reads without replacing the production owner, lookup, equality or overlay. */
function observeFieldReads(
  rows: readonly object[],
  keys: readonly string[],
  count: () => void
): void {
  for (const row of rows) {
    for (const key of keys) {
      if (!Object.hasOwn(row, key)) {
        continue
      }
      const value: unknown = Reflect.get(row, key)
      Object.defineProperty(row, key, {
        configurable: true,
        enumerable: true,
        get: () => {
          count()
          return value
        }
      })
    }
  }
}

it('bounds retained placement work linearly on ordinary snapshot and unchanged frame replay at N/10N', async () => {
  const samples: { n: number; snapshotReads: number; frameReads: number }[] = []
  for (const n of [32, 320]) {
    const { runtime, bindPty } = setupMainOwnedWorkspace()
    for (let index = 0; index < n; index++) {
      const openPlacement = {
        invocationId: `switched-${index}`,
        generation: `generation-${index}`,
        placement: { afterTabId: `retired-source-${index}`, index },
        activate: false,
        viewerSelection: 'original-viewer'
      }
      await (index % 2 === 0
        ? runtime.publishStructuredAgentSessionTab({
            workspaceId: WORKTREE_ID,
            sessionId: `retained-${index}`,
            agent: 'codex',
            activate: false,
            check: () => {},
            openPlacement
          })
        : runtime.publishAgentLaunchTabInMainLayout({
            worktreeId: WORKTREE_ID,
            tabId: `retained-terminal-${index}`,
            leafId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
            launchAgent: 'codex',
            viewMode: 'terminal',
            viewer: 'none',
            placement: openPlacement.placement,
            openPlacement
          }))
    }
    let measuring: 'snapshot' | 'frame' | undefined
    const rowKeys = ['id', 'sessionId', 'parentTabId', 'leafId', 'openPlacement']
    let snapshotReads = 0
    let frameReads = 0
    const countRead = () => {
      if (measuring === 'snapshot') {
        snapshotReads++
      } else if (measuring === 'frame') {
        frameReads++
      }
    }
    const preserve = placementProjection.preserveSessionTabOpenPlacements
    const overlay = placementProjection.withPublishedSessionTabOpenPlacements
    // Observe the added owners while running their real bodies; unrelated title/status readers are outside this contract.
    const preserveObservation = vi
      .spyOn(placementProjection, 'preserveSessionTabOpenPlacements')
      .mockImplementation((...args) => {
        measuring = 'snapshot'
        try {
          return preserve(...args)
        } finally {
          measuring = undefined
        }
      })
    const overlayObservation = vi
      .spyOn(placementProjection, 'withPublishedSessionTabOpenPlacements')
      .mockImplementation((...args) => {
        observeFieldReads(args[0].tabs, ['id', 'entityId', 'terminal'], countRead)
        observeFieldReads(
          args[0].tabs.flatMap((tab) => tab.terminal?.panes ?? []),
          ['leafId', 'ptyId'],
          countRead
        )
        measuring = 'frame'
        try {
          return overlay(...args)
        } finally {
          measuring = undefined
        }
      })
    let frames = 0
    const layouts = new Map<string, PublishedWorkspaceLayout>()
    const subscription = runtime.subscribeWorkspaceLayouts((event) => {
      frames++
      if (event.type === 'records') {
        for (const change of event.workspaces) {
          const next = applyWorkspaceLayoutRecordChange(layouts.get(change.key), change)
          if (next) {
            layouts.set(change.key, next)
          } else {
            layouts.delete(change.key)
          }
        }
      }
    })
    for (const entry of subscription.snapshot) {
      layouts.set(entry.key, entry.layout)
    }
    try {
      const existing = runtime.mobileSessionTabsByWorktree.get(WORKTREE_ID)
      if (!existing) {
        throw new Error('missing actual publication rows')
      }
      expect(existing.tabs.filter((row) => 'openPlacement' in row)).toHaveLength(n)
      // An ordinary graph replay omits optional metadata; the same destination retains it.
      const replay = {
        ...existing,
        tabs: existing.tabs.map((row) => {
          if (row.type !== 'agent-session' && row.type !== 'terminal') {
            return { ...row }
          }
          const { openPlacement: _placement, ...rest } = row
          return rest
        })
      }
      observeFieldReads(existing.tabs, rowKeys, countRead)
      observeFieldReads(replay.tabs, rowKeys, countRead)
      runtime.storeMobileSessionSnapshot(WORKTREE_ID, replay)
      const retained = runtime.mobileSessionTabsByWorktree.get(WORKTREE_ID)
      if (!retained) {
        throw new Error('ordinary replay lost rows')
      }
      expect(retained.tabs.filter((row) => 'openPlacement' in row)).toHaveLength(n)
      const replayReads = snapshotReads
      observeFieldReads(retained.tabs, rowKeys, countRead)
      const before = frames
      // An unchanged ordinary Store write still runs projection/overlay, but emits no duplicate frame.
      bindPty({ worktreeId: WORKTREE_ID, tabId: TAB_ID, leafId: LEAF_A, ptyId: PTY_A })
      await Promise.resolve()
      await Promise.resolve()
      expect(frames).toBe(before)
      expect(frameReads).toBeGreaterThanOrEqual(n)
      expect(snapshotReads).toBeGreaterThanOrEqual(n)
      const shown = [...layouts.values()].find((layout) => layout.worktreeId === WORKTREE_ID)
      expect(shown?.tabs.filter((tab) => tab.openPlacement)).toHaveLength(n)
      const unchangedFrameReads = frameReads
      // A real metadata change still publishes through the same ordinary live overlay.
      runtime.projectStructuredAgentSessionTab({
        workspaceId: WORKTREE_ID,
        sessionId: 'retained-0',
        agent: 'codex',
        activate: false,
        openPlacement: {
          invocationId: 'reopened-0',
          generation: 'reopened-generation',
          placement: { index: 0 },
          activate: false,
          viewerSelection: 'current-viewer'
        }
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(frames).toBe(before + 1)
      expect(
        [...layouts.values()]
          .flatMap((layout) => layout.tabs)
          .find((tab) => tab.entityId === 'retained-0')?.openPlacement
      ).toMatchObject({ generation: 'reopened-generation', viewerSelection: 'current-viewer' })
      samples.push({ n, snapshotReads: replayReads, frameReads: unchangedFrameReads })
    } finally {
      subscription.unsubscribe()
      preserveObservation.mockRestore()
      overlayObservation.mockRestore()
    }
  }
  console.info('MAIN_OPEN_PLACEMENT_WORK', JSON.stringify(samples))
  for (const sample of samples) {
    expect(sample.snapshotReads).toBeLessThanOrEqual(32 * (sample.n + 1))
    expect(sample.frameReads).toBeLessThanOrEqual(32 * (sample.n + 1))
  }
  expect(samples[1].snapshotReads).toBeLessThanOrEqual(samples[0].snapshotReads * 11)
  expect(samples[1].frameReads).toBeLessThanOrEqual(samples[0].frameReads * 11)
})
