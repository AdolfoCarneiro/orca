// @vitest-environment happy-dom

import { act, createElement, useCallback, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitConflictOperation } from '../../../../shared/git-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { useStaleConflictOperationPolling } from './stale-conflict-operation-poll'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ownerTarget = vi.hoisted(() => vi.fn<() => RuntimeClientTarget>())
vi.mock('./worktree-git-owner-target', () => ({ getWorktreeGitOwnerTarget: ownerTarget }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))

const worktrees = ['one', 'two'].map((name) => ({
  id: `repo::/repo/${name}`,
  path: `/repo/${name}`,
  repoId: 'repo'
}))
const initialOperations: Record<string, GitConflictOperation> = Object.fromEntries(
  worktrees.map(({ id }) => [id, 'merge'])
)
const repoMap = new Map([['repo', { kind: 'git' as const }]])
const slowTaskBackoff = { idleMultiplier: 1, changeSignalMultiplier: 1, maxIntervalMs: 300_000 }
const isConnectionReady = () => true
const request = vi.fn<() => Promise<GitConflictOperation>>()
let root: Root
let container: HTMLDivElement

function HookProbe({ enabled }: { enabled: boolean }): React.JSX.Element {
  const [operations, setOperations] = useState(initialOperations)
  const setConflictOperation = useCallback((id: string, operation: GitConflictOperation) => {
    setOperations((previous) =>
      previous[id] === operation ? previous : { ...previous, [id]: operation }
    )
  }, [])
  useStaleConflictOperationPolling({
    enabled,
    activeWorktreeId: null,
    allWorktrees: worktrees,
    repoMap,
    conflictOperationByWorktree: operations,
    setConflictOperation,
    isConnectionReady,
    slowTaskBackoff
  })
  return createElement('output', null, worktrees.map(({ id }) => operations[id]).join(','))
}

async function render(enabled: boolean): Promise<void> {
  await act(async () => root.render(createElement(HookProbe, { enabled })))
}

async function setVisibility(state: DocumentVisibilityState): Promise<void> {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
}

describe.each(['local', 'environment'] as const)('stale conflict polling on %s', (route) => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    clearRuntimeCompatibilityCacheForTests()
    request.mockReset().mockResolvedValue('merge')
    ownerTarget.mockReturnValue(
      route === 'local' ? { kind: 'local' } : { kind: 'environment', environmentId: 'remote' }
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        git: { conflictOperation: () => request() },
        runtimeEnvironments: {
          call: async ({ method }: { method: string }) => ({
            id: method,
            ok: true,
            result:
              method === 'status.get'
                ? {
                    runtimeId: 'remote-runtime',
                    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
                    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
                  }
                : await request(),
            _meta: { runtimeId: 'remote-runtime' }
          })
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    expect(vi.getTimerCount()).toBe(0)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('stops the batch after hiding during a successful probe and clears badges on resume', async () => {
    const pending = Promise.withResolvers<GitConflictOperation>()
    request.mockReturnValueOnce(pending.promise)
    await render(true)
    expect(request).toHaveBeenCalledTimes(1)

    await setVisibility('hidden')
    await act(async () => pending.resolve('merge'))
    await act(async () => vi.advanceTimersByTimeAsync(10_000))

    expect(request).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('merge,merge')

    request.mockResolvedValue('unknown')
    await setVisibility('visible')

    expect(container.textContent).toBe('unknown,unknown')
    expect(request).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops after a pending probe rejects during cleanup and refreshes on reenable', async () => {
    const pending = Promise.withResolvers<GitConflictOperation>()
    request.mockReturnValueOnce(pending.promise)
    await render(true)
    expect(request).toHaveBeenCalledTimes(1)

    await render(false)
    await act(async () => pending.reject(new Error('Disconnected during probe')))
    await act(async () => vi.advanceTimersByTimeAsync(10_000))

    expect(request).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('merge,merge')

    request.mockResolvedValue('unknown')
    await render(true)

    expect(container.textContent).toBe('unknown,unknown')
    expect(request).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })
})
