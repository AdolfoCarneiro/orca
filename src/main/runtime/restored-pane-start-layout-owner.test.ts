// Restored panes share main's starter across first-view, CLI and orchestration triggers.
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')
const { committingSpawn } = await import('./bind-first-pane.test-fixture')

const PANE = { worktreeId: TEST_WORKTREE_ID, tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }

function windowlessRuntime() {
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  const started = deferred<{ id: string }>()
  const spawn = vi.fn(
    (_args: Parameters<NonNullable<RuntimePtyController['spawn']>>[0]) => started.promise
  )
  runtime.setPtyController({
    spawn: committingSpawn(runtime, spawn),
    write: () => true,
    kill: () => false,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, spawn, started, getSession, setSession }
}

describe('a restored pane with no live terminal, on a host with no window (layout-owner build)', () => {
  it('starts once from its stored terminal for a client first view and a CLI trigger together', async () => {
    const { runtime, spawn, started } = windowlessRuntime()

    const firstView = runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      { notifyClients: false, navigation: 'caller', intent: 'user' }
    )
    const cliSend = runtime.ensureRestoredPaneStarted(PANE)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.resolve({ id: 'persisted-pty' })

    await expect(cliSend).resolves.toEqual({ id: 'persisted-pty' })
    await firstView
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'persisted-pty', tabId: 'host-tab' })
    )
    await expect(runtime.ensureRestoredPaneStarted(PANE)).resolves.toEqual({ id: 'persisted-pty' })
    expect(spawn).toHaveBeenCalledOnce()
  })

  it.each(['quit', 'worktree-sleep'] as const)(
    'keeps the in-place shell and original %s record on C1 null',
    async (origin) => {
      const { runtime, spawn, started, getSession, setSession } = windowlessRuntime()
      const record = {
        paneKey: `${PANE.tabId}:${PANE.leafId}`,
        tabId: PANE.tabId,
        worktreeId: TEST_WORKTREE_ID,
        agent: 'claude' as const,
        providerSession: { key: 'session_id' as const, id: 'saved' },
        launchConfig: { agentArgs: '"', agentEnv: {} },
        prompt: '',
        state: 'working' as const,
        origin,
        capturedAt: 1,
        updatedAt: 1
      }
      const session = getSession()
      const tab = session.tabsByWorktree[TEST_WORKTREE_ID]?.[0]
      if (!tab) {
        throw new Error('Missing stored terminal')
      }
      setSession({
        ...session,
        tabsByWorktree: { [TEST_WORKTREE_ID]: [{ ...tab, ptyId: null }] },
        terminalLayoutsByTabId: {
          [PANE.tabId]: {
            root: { type: 'leaf', leafId: PANE.leafId },
            activeLeafId: PANE.leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: {}
          }
        },
        sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
      })
      const claimedBeforeSpawn = getSession().sleepingAgentSessionsByPaneKey?.[record.paneKey]
      const reopened = runtime.ensureRestoredPaneStarted(PANE)
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: PANE.tabId, leafId: PANE.leafId })
      )
      expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty(
        'resumeProviderSession',
        record.providerSession
      )
      expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty(
        'command',
        expect.stringContaining('--resume')
      )
      expect(getSession().sleepingAgentSessionsByPaneKey?.[record.paneKey]).toBe(claimedBeforeSpawn)
      expect(claimedBeforeSpawn?.restoreOnTabOpenOnly).toBeUndefined()
      started.resolve({ id: 'restored-shell' })
      await expect(reopened).resolves.toEqual({ id: 'restored-shell' })
      expect(getSession().sleepingAgentSessionsByPaneKey?.[record.paneKey]).toBe(record)
    }
  )

  it('answers null for a pane main no longer holds, starting nothing', async () => {
    const { runtime, spawn } = windowlessRuntime()

    await expect(
      runtime.ensureRestoredPaneStarted({ ...PANE, tabId: 'tab-gone' })
    ).resolves.toBeNull()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('resolves to the terminal its start registered, not the id the pane stored', async () => {
    const { runtime, started } = windowlessRuntime()

    const cliSend = runtime.ensureRestoredPaneStarted(PANE)
    started.resolve({ id: 'pty-fresh' })

    await expect(cliSend).resolves.toEqual({ id: 'pty-fresh' })
  })

  it("refuses a client's first view of a pane main dropped after the client listed it", async () => {
    const { runtime, spawn, getSession, setSession } = windowlessRuntime()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const session = getSession()
    setSession({
      ...session,
      tabsByWorktree: { ...session.tabsByWorktree, [TEST_WORKTREE_ID]: [] }
    })

    await expect(
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      })
    ).rejects.toThrow('tab_not_found')
    expect(spawn).not.toHaveBeenCalled()
  })
})

it.skipIf(process.platform === 'win32')(
  'refuses before physical dispatch, then carries canonical Pi identity through corrected ensure/create/C1/admission',
  async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pr33921-canonical-pi-'))
    try {
      const transcript = join(folder, 'A.jsonl')
      const alias = join(folder, 'current.jsonl')
      writeFileSync(transcript, '{}\n')
      symlinkSync(transcript, alias)
      const { runtime, spawn, getSession } = windowlessRuntime()
      const signing = vi.spyOn(runtime['agentSessionClaimSigner'], 'createClaim')
      spawn.mockImplementation(async (args) => ({
        id: 'canonical-pi',
        launchAgent: args.launchAgent,
        resumeProviderSession: args.resumeProviderSession
      }))
      const request = {
        kind: 'explicit' as const,
        worktree: `id:${TEST_WORKTREE_ID}`,
        agent: 'pi' as const,
        providerSession: { key: 'session_id' as const, id: 'ordinary-fallback' },
        resume: {
          recipe: { source: 'saved' as const },
          providerSession: {
            key: 'session_id' as const,
            id: ' preferred ',
            transcriptPath: alias
          }
        }
      }
      const original = getSession()
      await expect(
        runtime.ensureAgentSession({
          ...request,
          resume: {
            ...request.resume,
            recipe: { source: 'saved', launchConfig: { agentArgs: '"', agentEnv: {} } }
          }
        })
      ).rejects.toThrow('Could not build resume command for pi.')
      expect(spawn).not.toHaveBeenCalled()
      expect(getSession()).toBe(original)
      const result = await runtime.ensureAgentSession(request)
      const canonical = {
        key: 'session_id',
        id: 'preferred',
        transcriptPath: realpathSync(transcript)
      }
      expect(signing.mock.calls[0]?.[0].identity.providerSession).toEqual(canonical)
      expect(spawn).toHaveBeenCalledOnce()
      const dispatched = spawn.mock.calls[0]?.[0]
      expect(dispatched?.resumeProviderSession).toEqual(canonical)
      expect(dispatched?.command).toContain(realpathSync(transcript))
      expect(dispatched?.command).not.toContain(alias)
      expect(dispatched?.agentSessionEnsure?.claim).toEqual(signing.mock.results.at(-1)?.value)
      expect(result.terminal.resumeProviderSession).toEqual(canonical)
    } finally {
      rmSync(folder, { recursive: true })
    }
  }
)
