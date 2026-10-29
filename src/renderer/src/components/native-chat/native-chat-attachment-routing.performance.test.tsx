// @vitest-environment happy-dom
import { Profiler } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { NativeChatTextAttachmentScope } from './NativeChatTextAttachments'
import {
  useNativeChatImageRuntimeContext,
  type NativeChatImageRuntimeContext
} from './native-chat-image-runtime-context'
import {
  detectedListingFixture,
  agentSessionTabFixture,
  repoFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'

vi.mock('./NativeChatTextAttachmentPreview', () => ({
  NativeChatTextAttachmentPreview: () => null
}))
const initial = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

function ssh(
  generation: number
): AppState['sshStateByEnvironment'] extends Map<string, infer T> ? T : never {
  return {
    targets: [],
    targetGenerations: new Map(),
    targetLabels: new Map(),
    removedTargetLabels: new Map(),
    targetsHydrated: true,
    connectionStates: new Map([
      [
        'ssh-1',
        {
          targetId: 'ssh-1',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          connectionGeneration: generation
        }
      ]
    ])
  }
}

function instrument<T extends { id: string }>(row: T, visit: () => void): T {
  const id = row.id
  Object.defineProperty(row, 'id', {
    enumerable: true,
    get() {
      visit()
      return id
    }
  })
  return row
}

for (const mode of ['scope-only', 'with-probe', 'disabled'] as const) {
  it(`bounds actual SSH and floating catalog work separately from renders (${mode})`, async () => {
    for (const floating of [false, true]) {
      for (const n of [10, 100]) {
        let visits = 0,
          commits = 0,
          renders = 0
        const ws = floating ? FLOATING_TERMINAL_WORKTREE_ID : 'wt-0'
        const tabs = Array.from({ length: n }, (_, i) =>
          instrument(
            agentSessionTabFixture(`chat-${i}`, ws, { entityId: `session-${i}` }),
            () => visits++
          )
        )
        const rows = Array.from({ length: n }, (_, i) =>
          instrument(
            worktreeFixture(`wt-${i}`, `/remote/${i}`, {
              hostId: 'ssh:ssh-1',
              runtimeOwnerEnvironmentId: 'owner-a'
            }),
            () => visits++
          )
        )
        const pins = Object.fromEntries(
          tabs.map((tab, i) => [
            `chat-${i}`,
            { sessionId: tab.entityId, launchDirectory: `/pinned/${i}` }
          ])
        )
        useAppStore.setState(
          {
            ...initial,
            settings: getDefaultSettings('/test-home'),
            repos: [repoFixture({ executionHostId: 'runtime:owner-a' })],
            worktreesByRepo: { repo: rows },
            detectedWorktreesByRepo: {},
            folderWorkspaces: [],
            projectGroups: [],
            runtimeEnvironments: [
              {
                id: 'owner-a',
                name: 'owner-a',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: null,
                runtimeId: null,
                preferredEndpointId: 'endpoint',
                endpoints: []
              }
            ],
            runtimeEnvironmentCatalogHydrated: true,
            removedRuntimeEnvironmentIds: new Set(),
            restoredRuntimeHostIdByWorkspaceSessionKey: {},
            tabsByWorktree: {},
            unifiedTabsByWorktree: { [ws]: tabs },
            structuredSessionLaunchDirectoryByTabId: pins,
            activeWorktreeId: floating ? null : ws,
            activeWorkspaceExecutionHostId: floating ? null : 'ssh:ssh-1',
            sshStateByEnvironment: new Map([['owner-a', ssh(3)]])
          },
          true
        )
        const contexts: NativeChatImageRuntimeContext[] = []
        function Probe({ index }: { index: number }) {
          contexts[index] = useNativeChatImageRuntimeContext(`chat-${index}`)
          renders++
          return null
        }
        visits = 0
        const view = render(
          tabs.map((_, index) => (
            <Profiler key={index} id={String(index)} onRender={() => commits++}>
              <NativeChatTextAttachmentScope tabId={`chat-${index}`} enabled={mode !== 'disabled'}>
                {mode === 'with-probe' ? <Probe index={index} /> : <span />}
              </NativeChatTextAttachmentScope>
            </Profiler>
          ))
        )
        await act(async () => {})
        // Shared immutable indexes plus addressed lookup, including cold catalogs, are additive.
        expect(visits).toBeLessThanOrEqual(mode === 'disabled' ? 0 : 12 * n)
        const baseline = contexts.map((context) => JSON.stringify(context))
        const metrics = []
        for (const kind of ['other-host', 'other-target', 'other-pin'] as const) {
          const state = useAppStore.getState()
          const patch =
            kind === 'other-host'
              ? {
                  sshStateByEnvironment: new Map([
                    ...state.sshStateByEnvironment,
                    ['other-host', ssh(8)]
                  ])
                }
              : kind === 'other-target'
                ? {
                    sshStateByEnvironment: new Map([
                      ...state.sshStateByEnvironment,
                      [
                        'owner-a',
                        {
                          ...ssh(3),
                          connectionStates: new Map([
                            ...ssh(3).connectionStates,
                            [
                              'other-target',
                              {
                                targetId: 'other-target',
                                status: 'connected' as const,
                                error: null,
                                reconnectAttempt: 0,
                                connectionGeneration: 8
                              }
                            ]
                          ])
                        }
                      ]
                    ])
                  }
                : {
                    structuredSessionLaunchDirectoryByTabId: {
                      ...pins,
                      unmounted: { sessionId: 'other', launchDirectory: '/other' }
                    }
                  }
          visits = 0
          commits = 0
          renders = 0
          await act(async () => useAppStore.setState(patch))
          expect(contexts.map((context) => JSON.stringify(context))).toEqual(baseline)
          expect(commits).toBe(0)
          expect(renders).toBe(0)
          expect(visits).toBe(0)
          metrics.push({ kind, visits, commits, renders })
        }
        visits = 0
        commits = 0
        renders = 0
        await act(async () =>
          useAppStore.setState(
            floating
              ? {
                  structuredSessionLaunchDirectoryByTabId: {
                    ...pins,
                    'chat-0': { sessionId: 'session-0', launchDirectory: '/changed' }
                  }
                }
              : { sshStateByEnvironment: new Map([['owner-a', ssh(4)]]) }
          )
        )
        expect(commits).toBe(mode === 'disabled' ? 0 : floating ? 1 : n)
        expect(renders).toBe(mode === 'with-probe' ? (floating ? 1 : n) : 0)
        expect(visits).toBeLessThanOrEqual(mode === 'disabled' ? 0 : 4 * n)
        if (mode === 'with-probe') {
          expect(contexts[0]).toMatchObject(
            floating ? { worktreePath: '/changed' } : { expectedSshConnectionGeneration: 4 }
          )
          if (floating) {
            expect(contexts[1]?.worktreePath).toBe('/pinned/1')
          }
        }
        // Replaced catalogs may be scanned once, never once per mounted consumer.
        const replacement = floating
          ? { unifiedTabsByWorktree: { [ws]: [...tabs] } }
          : { worktreesByRepo: { repo: [...rows] } }
        visits = 0
        commits = 0
        renders = 0
        await act(async () => useAppStore.setState(replacement))
        // The store's existing catalog publisher also visits rows in the disabled control.
        expect(visits).toBeLessThanOrEqual(12 * n)
        expect(commits).toBe(0)
        expect(renders).toBe(0)
        console.info(
          'attachment-routing-work',
          JSON.stringify({ mode, floating, n, metrics, replacementVisits: visits })
        )
        view.unmount()
      }
    }
  })
}

it('shares cold all-rival transport aggregation without losing ambiguity or catalog precedence', async () => {
  for (const n of [10, 100]) {
    let visits = 0,
      provenanceReads = 0
    const rows = Array.from({ length: n }, () => {
      const row = instrument(
        worktreeFixture('wt-0', '/remote', {
          hostId: 'ssh:ssh-1',
          runtimeOwnerEnvironmentId: 'owner-a'
        }),
        () => visits++
      )
      Object.defineProperty(row, 'runtimeOwnerEnvironmentId', {
        enumerable: true,
        get() {
          provenanceReads++
          return 'owner-a'
        }
      })
      return row
    })
    useAppStore.setState(
      {
        ...initial,
        repos: [repoFixture()],
        worktreesByRepo: { repo: rows },
        detectedWorktreesByRepo: {},
        unifiedTabsByWorktree: {
          'wt-0': Array.from({ length: n }, (_, i) => agentSessionTabFixture(`chat-${i}`, 'wt-0'))
        },
        activeWorktreeId: 'wt-0',
        activeWorkspaceExecutionHostId: 'ssh:ssh-1',
        sshStateByEnvironment: new Map([['owner-a', ssh(3)]])
      },
      true
    )
    const contexts: NativeChatImageRuntimeContext[] = []
    function Probe({ index }: { index: number }) {
      contexts[index] = useNativeChatImageRuntimeContext(`chat-${index}`)
      return null
    }
    const view = render(
      Array.from({ length: n }, (_, index) => <Probe key={index} index={index} />)
    )
    await act(async () => {})
    expect(
      contexts.every(
        (context) =>
          context?.target.kind === 'environment' && context.target.environmentId === 'owner-a'
      )
    ).toBe(true)
    expect(visits).toBeLessThanOrEqual(8 * n)
    expect(provenanceReads).toBeLessThanOrEqual(20 * n)
    await act(async () =>
      useAppStore.setState({
        worktreesByRepo: {
          repo: [
            ...rows,
            worktreeFixture('wt-0', '/rival', {
              hostId: 'ssh:ssh-1',
              runtimeOwnerEnvironmentId: 'owner-b'
            })
          ]
        }
      })
    )
    expect(contexts.every((context) => context === null)).toBe(true)
    // Removing the rival and replacing the first directory row restores the original owner.
    await act(async () =>
      useAppStore.setState({
        worktreesByRepo: {
          repo: [
            worktreeFixture('wt-0', '/first', {
              hostId: 'ssh:ssh-1',
              runtimeOwnerEnvironmentId: 'owner-a'
            }),
            ...rows
          ]
        }
      })
    )
    expect(contexts.every((context) => context?.worktreePath === '/first')).toBe(true)
    // Detected rivals still participate even with a known row and active physical host.
    await act(async () =>
      useAppStore.setState({
        detectedWorktreesByRepo: {
          rival: detectedListingFixture([
            worktreeFixture('wt-0', '/detected', {
              hostId: 'ssh:ssh-1',
              runtimeOwnerEnvironmentId: 'owner-b'
            })
          ])
        }
      })
    )
    expect(contexts.every((context) => context === null)).toBe(true)
    view.unmount()
  }
})
