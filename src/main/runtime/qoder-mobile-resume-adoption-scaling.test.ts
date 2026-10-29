import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import type { OwnedMobileTerminalCreateOptions } from './terminal/launch/mobile-terminal-create'

await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')

type SpawnPane = { worktreeId?: string; tabId?: string; leafId?: string }

class QoderScaleRuntime extends OrcaRuntimeService {
  createOwned(worktreeId: string, opts: OwnedMobileTerminalCreateOptions) {
    return this.createRuntimeOwnedMobileSessionTerminal(worktreeId, false, undefined, opts)
  }
}

it('bounds lost-reply persisted-surface reconciliation at N/10N without replaying the create', async () => {
  const { fixture } =
    await import('../persistence/loading-store/profile-state-delayed-authority-fixture')
  const samples: { n: number; tabReads: number; bindingReads: number }[] = []
  for (const n of [10, 100]) {
    const { store: durable } = await fixture()
    const worktreeId = 'repo-local::/fixture/local'
    const runtime = new QoderScaleRuntime(durable)
    Object.assign(runtime, {
      resolveTerminalWorkspaceLaunchScope: async () => ({
        id: worktreeId,
        path: '/fixture/local',
        connectionId: null,
        repo: null,
        folderWorkspace: null
      })
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const request = {
      command: 'qodercli --resume original',
      launchAgent: 'qoder' as const,
      launchConfig: { agentCommand: 'qodercli', agentArgs: '--original', agentEnv: {} },
      createMutation: { clientIdentity: 'scale-phone', id: 'scale-operation' }
    }
    const inventory: {
      id: string
      worktreeId: string
      terminalHandle: string
      cwd: string
      title: string
    }[] = []
    const spawn = vi.fn(async (args: SpawnPane & { preAllocatedHandle?: string }) => {
      if (!args.preAllocatedHandle) {
        throw new Error('missing actual handle')
      }
      inventory.push({
        id: 'scale-live',
        worktreeId,
        terminalHandle: args.preAllocatedHandle,
        cwd: '/fixture/local',
        title: 'Qoder'
      })
      throw new Error('lost-spawn-reply')
    })
    const kill = vi.fn()
    runtime.setPtyController({
      spawn,
      kill,
      write: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => inventory
    })
    await expect(runtime.createOwned(worktreeId, request)).rejects.toThrow('lost-spawn-reply')
    let current = { tabId: '', leafId: '' }
    for (let index = 0; index < n; index++) {
      current = {
        tabId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        leafId: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`
      }
      await durable.admitTerminalPane({
        type: 'createTerminalTab',
        workspace: worktreeId,
        ...current
      })
      await durable.persistPtyBinding({
        worktreeId,
        ...current,
        ptyId: index === n - 1 ? 'scale-live' : `unrelated-${index}`
      })
    }
    let measuring = true
    let tabReads = 0
    let bindingReads = 0
    const observedTabs = new WeakSet<object>()
    const observedBindings = new WeakSet<object>()
    const read = runtime.getWorkspaceSessionForWorktree.bind(runtime)
    const observer = vi
      .spyOn(runtime, 'getWorkspaceSessionForWorktree')
      .mockImplementation((id) => {
        const session = read(id)
        measuring = false
        for (const tab of session?.tabsByWorktree[worktreeId] ?? []) {
          if (!observedTabs.has(tab)) {
            observedTabs.add(tab)
            const value = tab.id
            Object.defineProperty(tab, 'id', {
              configurable: true,
              enumerable: true,
              get: () => {
                if (measuring) {
                  tabReads++
                }
                return value
              }
            })
          }
          const bindings = session?.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId
          if (bindings && !observedBindings.has(bindings)) {
            observedBindings.add(bindings)
            for (const [leafId, value] of Object.entries(bindings)) {
              Object.defineProperty(bindings, leafId, {
                configurable: true,
                enumerable: true,
                get: () => {
                  if (measuring) {
                    bindingReads++
                  }
                  return value
                }
              })
            }
          }
        }
        measuring = true
        return session
      })
    try {
      const result = await runtime.createOwned(worktreeId, {
        ...request,
        identity: { tabId: 'unrelated-retry', leafId: '99999999-9999-4999-8999-999999999999' }
      })
      expect(result.tab).toMatchObject({
        parentTabId: current.tabId,
        leafId: current.leafId,
        ptyId: 'scale-live'
      })
      expect(result.tab.parentTabId).not.toBe(spawn.mock.calls[0][0].tabId)
      expect(spawn).toHaveBeenCalledOnce()
      expect(kill).not.toHaveBeenCalled()
      samples.push({ n, tabReads, bindingReads })
    } finally {
      observer.mockRestore()
    }
  }
  for (const sample of samples) {
    expect(sample.bindingReads).toBeGreaterThanOrEqual(2 * sample.n)
    expect(sample.bindingReads).toBeLessThanOrEqual(2 * sample.n + 5)
    expect(sample.tabReads).toBeLessThanOrEqual(7 * sample.n + 9)
  }
  expect(samples[1].bindingReads).toBeLessThanOrEqual(10 * samples[0].bindingReads)
  expect(samples[1].tabReads).toBeLessThanOrEqual(10 * samples[0].tabReads)
})
