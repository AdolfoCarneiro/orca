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
  nativeChatFanoutFixture,
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

for (const mode of ['scope-only', 'with-probe', 'disabled'] as const) {
  it.each(['inactive-detected', 'folder-twins', 'detected-twins', 'unstamped-project'] as const)(
    `shares all directory and explicit-route derivation for %s (${mode})`,
    async (kind) => {
      for (const n of [10, 100]) {
        let operations = 0,
          commits = 0,
          renders = 0
        const meter = <T extends object, K extends keyof T>(row: T, key: K): T => {
          const value = row[key]
          Object.defineProperty(row, key, {
            enumerable: true,
            get: () => {
              operations++
              return value
            }
          })
          return row
        }
        const folderCase = kind === 'folder-twins'
        const unstamped = kind === 'unstamped-project'
        const fixture = nativeChatFanoutFixture(n, 1, 0)
        const ws = folderCase ? 'folder:workspace-0' : 'wt-0'
        const known = worktreeFixture(
          ws,
          '/own',
          unstamped
            ? {}
            : {
                hostId: 'ssh:ssh-1',
                runtimeOwnerEnvironmentId: 'owner-a'
              }
        )
        const detected = Array.from({ length: n }, (_, index) =>
          meter(
            worktreeFixture(
              ws,
              kind === 'detected-twins' && index < n - 1 ? '/other' : '/own',
              unstamped
                ? {}
                : kind === 'detected-twins' && index < n - 1
                  ? { hostId: `runtime:other-${index}` }
                  : { hostId: 'ssh:ssh-1', runtimeOwnerEnvironmentId: 'owner-a' }
            ),
            'runtimeOwnerEnvironmentId'
          )
        )
        const folders = Array.from({ length: n }, (_, index) =>
          meter(
            {
              ...fixture.folderWorkspaces[0]!,
              folderPath: index === n - 1 ? '/own' : '/other',
              executionHostId:
                index === n - 1 ? ('runtime:owner-a' as const) : (`runtime:other-${index}` as const)
            },
            'executionHostId'
          )
        )
        const repos = unstamped
          ? Array.from({ length: n }, (_, index) =>
              meter(
                repoFixture({
                  executionHostId: index % 2 ? 'runtime:owner-a' : 'local'
                }),
                'id'
              )
            )
          : [repoFixture({ executionHostId: 'runtime:owner-a' })]
        useAppStore.setState(
          {
            ...initial,
            ...fixture,
            repos,
            worktreesByRepo: folderCase || kind === 'detected-twins' ? {} : { repo: [known] },
            detectedWorktreesByRepo: folderCase
              ? {}
              : { repo: { ...detectedListingFixture([]), worktrees: detected } },
            folderWorkspaces: folderCase ? folders : [],
            unifiedTabsByWorktree: {
              [ws]: Array.from({ length: n }, (_, i) => agentSessionTabFixture(`chat-${i}`, ws))
            },
            activeWorktreeId: folderCase || kind === 'detected-twins' ? ws : 'different-workspace',
            activeWorkspaceExecutionHostId:
              folderCase || kind === 'detected-twins' ? 'runtime:owner-a' : 'local',
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
        operations = 0
        const view = render(
          Array.from({ length: n }, (_, index) => (
            <Profiler key={index} id={String(index)} onRender={() => commits++}>
              <NativeChatTextAttachmentScope tabId={`chat-${index}`} enabled={mode !== 'disabled'}>
                {mode === 'with-probe' ? <Probe index={index} /> : <span />}
              </NativeChatTextAttachmentScope>
            </Profiler>
          ))
        )
        await act(async () => {})
        const bound = mode === 'disabled' ? 0 : 20 * n
        expect(operations).toBeLessThanOrEqual(bound)
        if (mode === 'with-probe') {
          expect(contexts).toHaveLength(n)
          expect(contexts.every((context) => context?.worktreePath === '/own')).toBe(true)
          expect(contexts[0]?.target).toEqual(
            unstamped ? { kind: 'local' } : { kind: 'environment', environmentId: 'owner-a' }
          )
        }
        const metrics = [{ event: 'cold', operations, commits, renders }]
        const check = async (
          event: string,
          patch: Partial<AppState>,
          changed = false,
          expectedPath: string | null = '/own',
          limit = bound
        ) => {
          operations = 0
          commits = 0
          renders = 0
          await act(async () => useAppStore.setState(patch))
          expect(operations).toBeLessThanOrEqual(limit)
          expect(commits).toBe(changed && mode !== 'disabled' ? n : 0)
          expect(renders).toBe(changed && mode === 'with-probe' ? n : 0)
          if (mode === 'with-probe') {
            expect(
              contexts.every((context) =>
                expectedPath === null ? context === null : context?.worktreePath === expectedPath
              )
            ).toBe(true)
          }
          metrics.push({ event, operations, commits, renders })
        }
        await check('known replacement', {
          worktreesByRepo: { ...useAppStore.getState().worktreesByRepo }
        })
        await check(
          'directory catalog replacement',
          folderCase
            ? { folderWorkspaces: [...folders] }
            : {
                detectedWorktreesByRepo: {
                  repo: { ...detectedListingFixture([]), worktrees: [...detected] }
                }
              }
        )
        await check('repo replacement', { repos: [...repos] })
        await check(
          'other host',
          {
            sshStateByEnvironment: new Map([
              ['owner-a', ssh(3)],
              ['other', ssh(8)]
            ])
          },
          false,
          '/own',
          0
        )
        if (kind === 'inactive-detected') {
          for (const generation of [4, null, 5]) {
            await check(
              'own generation',
              {
                sshStateByEnvironment: new Map([
                  [
                    'owner-a',
                    generation === null
                      ? { ...ssh(3), connectionStates: new Map() }
                      : ssh(generation)
                  ]
                ])
              },
              true,
              generation === null ? null : '/own',
              0
            )
            if (mode === 'with-probe' && generation !== null) {
              expect(
                contexts.every((context) => context?.expectedSshConnectionGeneration === generation)
              ).toBe(true)
            }
          }
        }
        if (!folderCase && kind !== 'detected-twins') {
          const rival = worktreeFixture(ws, '/rival', {
            hostId: 'ssh:ssh-1',
            runtimeOwnerEnvironmentId: 'owner-b'
          })
          await check(
            'nonfirst rival',
            {
              detectedWorktreesByRepo: {
                repo: { ...detectedListingFixture([]), worktrees: [...detected, rival] }
              }
            },
            true,
            null
          )
          await check(
            'rival removed',
            {
              detectedWorktreesByRepo: {
                repo: { ...detectedListingFixture([]), worktrees: detected }
              }
            },
            true
          )
        }
        if (unstamped) {
          await check(
            'SSH repo sibling',
            { repos: [...repos, repoFixture({ executionHostId: 'ssh:ssh-1' })] },
            true,
            null
          )
          await check('SSH repo sibling removed', { repos: [...repos] }, true)
        }
        const ownPath = folderCase
          ? {
              folderWorkspaces: [
                ...folders.slice(0, -1),
                { ...folders[n - 1]!, folderPath: '/changed' }
              ]
            }
          : kind === 'detected-twins'
            ? {
                detectedWorktreesByRepo: {
                  repo: {
                    ...detectedListingFixture([]),
                    worktrees: [...detected.slice(0, -1), { ...detected[n - 1]!, path: '/changed' }]
                  }
                }
              }
            : { worktreesByRepo: { repo: [{ ...known, path: '/changed' }] } }
        await check('own path', ownPath, true, '/changed')
        console.info('attachment-catalog-derivation', JSON.stringify({ mode, kind, n, metrics }))
        view.unmount()
      }
    }
  )
}
