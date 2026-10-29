import { fixture as durableFixture } from '../../persistence/loading-store/profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'
import {
  trackRunningAgentLaunchPane,
  resetAgentLaunchPanesForTests
} from '../../agent-launch/agent-launch-pane-attachment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_ID, setupMainOwnedWorkspace } from '../main-owned-workspace-runtime-fixture'
import { publishAgentLaunchTabEarly } from '../rpc/methods/agent-launch-tab-publication'
import type { PublishedTab } from '../../../shared/workspace-layout/workspace-layout-published'

// Layout-owner build, no window: an agent launch's early tab in a workspace main owns is written by
// main, a retry finds it, and a withdrawn launch pane is taken back by main.

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const NEW_TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const NEW_LEAF = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

afterEach(() => resetAgentLaunchPanesForTests())

function launchHost() {
  const fixture = setupMainOwnedWorkspace()
  Object.assign(fixture.runtime, {
    showTerminalWorkspaceLaunchScope: async () => ({ id: WORKTREE_ID, path: '/workspace' })
  })
  const context = { runtime: fixture.runtime }
  const launch = () =>
    publishAgentLaunchTabEarly(
      {
        agent: 'claude',
        target: { kind: 'existing', worktree: `id:${WORKTREE_ID}` },
        paneKey: `${NEW_TAB}:${NEW_LEAF}`,
        surface: 'terminal'
      },
      context
    )
  const tabIds = () => fixture.session().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id) ?? []
  return { fixture, launch, tabIds }
}

describe("an agent launch's early tab in a workspace main owns, with no window", () => {
  it("is written in main's layout before the launch runs", async () => {
    const { fixture, launch, tabIds } = launchHost()

    const early = await launch()

    expect(early?.paneKey).toBe(`${NEW_TAB}:${NEW_LEAF}`)
    expect(tabIds()).toContain(NEW_TAB)
    expect(
      fixture.session().tabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id === NEW_TAB)
    ).toMatchObject({ launchAgent: 'claude' })
  })

  it('takes the tab back when nothing will run in it', async () => {
    const { launch, tabIds } = launchHost()

    const early = await launch()
    // Never admitted: the launch made this tab, and nothing will ever run in it.
    early?.finish('agent_launch_refused')
    await vi.waitFor(() => expect(tabIds()).not.toContain(NEW_TAB))
  })

  it('keeps a tab a retry found, since that launch made none', async () => {
    const { launch, tabIds } = launchHost()

    await launch()
    resetAgentLaunchPanesForTests()
    const retry = await launch()
    retry?.finish('agent_launch_refused')
    await Promise.resolve()

    expect(tabIds()).toContain(NEW_TAB)
  })
})

describe("an agent launch's early tab in a workspace main owns, with a window attached", () => {
  it('is written by main, and the window keeps its pane, prompt and view without making a tab', async () => {
    const { fixture, tabIds } = launchHost()
    const publishAgentLaunchTab = vi.fn(async () => {
      throw new Error('the window makes no tab here')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the early tab reads only this notice.
    fixture.runtime.setNotifier({ publishAgentLaunchTab } as never)
    Object.assign(fixture.runtime, { getAvailableAuthoritativeWindow: () => ({}) })
    const context = { runtime: fixture.runtime }

    await publishAgentLaunchTabEarly(
      {
        agent: 'claude',
        target: { kind: 'existing', worktree: `id:${WORKTREE_ID}` },
        paneKey: `${NEW_TAB}:${NEW_LEAF}`,
        surface: 'terminal',
        prompt: { text: 'fix the build', delivery: 'submit' },
        operationId: 'op-1'
      },
      context
    )

    expect(tabIds()).toContain(NEW_TAB)
    // Told once main's tab is written, as the window's own publication was answered.
    await vi.waitFor(() =>
      expect(publishAgentLaunchTab).toHaveBeenCalledWith(
        expect.objectContaining({
          tabId: NEW_TAB,
          leafId: NEW_LEAF,
          prompt: 'fix the build',
          operationId: 'op-1',
          viewer: expect.any(String),
          shownByMain: { frameSeq: expect.any(Number), created: true }
        })
      )
    )
  })
})

// These schedules go through Store -> LayoutCommandPersistence's actual durable queue.
describe('conditional launch withdrawal at the durable writer', () => {
  const worktreeId = 'repo-local::/fixture/local'
  const pane = { worktreeId, tabId: NEW_TAB, leafId: NEW_LEAF, operationId: 'old-launch' }
  async function opened() {
    const state = await durableFixture()
    const runtime = new OrcaRuntimeService(state.store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const running = trackRunningAgentLaunchPane({ worktreeId, paneKey: `${NEW_TAB}:${NEW_LEAF}` })
    const shown = await runtime.publishAgentLaunchTabInMainLayout({
      ...pane,
      launchAgent: 'codex',
      viewMode: 'terminal',
      viewer: 'none'
    })
    if (!shown?.withdrawalRoot) {
      throw new Error('actual create did not capture placement')
    }
    return { ...state, runtime, running, shown }
  }
  it('keeps a destination after a new launch is accepted before its options resolve', async () => {
    const { store, authority, runtime, running, shown } = await opened()
    const pause = authority.pause()
    const preceding = store.runDurableMutation(() => ({ value: undefined }))
    await pause.started.promise
    const removing = runtime.withdrawAgentLaunchPaneInMainLayout(
      pane,
      running.current,
      shown.withdrawalRoot
    )
    runtime.noteAcceptedAgentLaunchPane(`${NEW_TAB}:${NEW_LEAF}`, 'new-preparing-launch')
    pause.finish.resolve()
    await preceding
    expect(await removing).toBe(false)
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[NEW_TAB]?.root).toMatchObject({
      leafId: NEW_LEAF
    })
  })
  it('rechecks acceptance after last_pane before its queued closeTabs', async () => {
    const { store, runtime, running, shown } = await opened()
    const apply = runtime.applyLayoutCommand.bind(runtime)
    const spy = vi.spyOn(runtime, 'applyLayoutCommand').mockImplementation(async (...args) => {
      const reply = await apply(...args)
      if (!reply.ok && reply.code === 'last_pane') {
        runtime.noteAcceptedAgentLaunchPane(`${NEW_TAB}:${NEW_LEAF}`, 'later-launch')
      }
      return reply
    })
    expect(
      await runtime.withdrawAgentLaunchPaneInMainLayout(pane, running.current, shown.withdrawalRoot)
    ).toBe(false)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(
      store.getWorkspaceSession().tabsByWorktree[worktreeId].some((row) => row.id === NEW_TAB)
    ).toBe(true)
  })
  it('refuses a queued create after expiry at the actual layout apply', async () => {
    const { store, authority } = await durableFixture()
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const pause = authority.pause()
    const preceding = store.runDurableMutation(() => ({ value: undefined }))
    await pause.started.promise
    let expired = false
    const creating = runtime.publishAgentLaunchTabInMainLayout(
      {
        ...pane,
        launchAgent: 'codex',
        viewMode: 'terminal',
        viewer: 'none'
      },
      () => {
        if (expired) {
          throw new Error('expired')
        }
      }
    )!
    const refused = expect(creating).rejects.toThrow('expired')
    expired = true
    pause.finish.resolve()
    await preceding
    await refused
    expect(
      store.getWorkspaceSession().tabsByWorktree[worktreeId].some((row) => row.id === NEW_TAB)
    ).toBe(false)
  })
})

it('uses a captured index through ordinary launch publication when its source already retired', async () => {
  const { fixture } = launchHost()
  const published: Pick<PublishedTab, 'id' | 'openPlacement'>[] = []
  const subscription = fixture.runtime.subscribeWorkspaceLayouts((event) => {
    if (event.type === 'workspace') {
      published.push(...event.layout.tabs)
    }
    if (event.type === 'records') {
      for (const change of event.workspaces) {
        if (change.change === 'layout') {
          published.push(...change.layout.tabs)
        }
        if (change.change === 'records') {
          published.push(...(change.tabs?.set ?? []))
        }
      }
    }
  })
  const request = {
    worktreeId: WORKTREE_ID,
    tabId: NEW_TAB,
    leafId: NEW_LEAF,
    launchAgent: 'codex' as const,
    viewMode: 'terminal' as const,
    viewer: 'none' as const,
    placement: { afterTabId: 'naturally-retired-source', index: 0 },
    openPlacement: {
      invocationId: 'captured-open',
      generation: 'captured-generation',
      placement: { afterTabId: 'naturally-retired-source', index: 0 },
      activate: false,
      viewerSelection: 'original-viewer'
    }
  }
  await fixture.runtime.publishAgentLaunchTabInMainLayout(request)
  const result = await fixture.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const group = fixture
    .session()
    .tabGroups?.[WORKTREE_ID]?.find((row) => row.tabOrder.includes(NEW_TAB))
  expect(group?.tabOrder[0]).toBe(NEW_TAB)
  const row = result.tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === NEW_TAB)
  expect(row).toMatchObject({ openPlacement: request.openPlacement })
  expect(published.find((tab) => tab.id === NEW_TAB)).toMatchObject({
    openPlacement: request.openPlacement
  })
  expect(JSON.stringify(fixture.session())).not.toContain('openPlacement')
  fixture.runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE_ID, { force: true })
  expect(
    (await fixture.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs.find(
      (tab) => tab.id === row?.id
    )
  ).toMatchObject({ openPlacement: request.openPlacement })
  subscription.unsubscribe()
})
