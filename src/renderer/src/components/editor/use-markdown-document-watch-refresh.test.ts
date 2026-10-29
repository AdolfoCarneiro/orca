// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../../../shared/filesystem-entry-types'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS } from './markdown-document-list-request'
import {
  getLatestMarkdownMembershipChangeAt,
  useMarkdownDocumentWatchRefresh
} from './use-markdown-document-watch-refresh'

let root: Root
let container: HTMLDivElement

function Harness({
  refresh,
  worktreePath = '/repo',
  runtimeEnvironmentId = null
}: {
  refresh: (requireFresh: boolean, freshAfter: number) => Promise<void>
  worktreePath?: string
  runtimeEnvironmentId?: string | null
}): null {
  useMarkdownDocumentWatchRefresh({
    enabled: true,
    worktreePath,
    runtimeEnvironmentId,
    refresh
  })
  return null
}

function change(
  events: FsChangeEvent[],
  worktreePath = '/repo',
  runtimeEnvironmentId: string | null = null
): void {
  window.dispatchEvent(
    new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
      detail: { runtimeEnvironmentId, payload: { worktreePath, events } }
    })
  )
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  act(() => root.unmount())
  await advance(MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS)
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useMarkdownDocumentWatchRefresh', () => {
  it('asks for a scan fresher than the latest change in the window', async () => {
    const refresh = vi.fn(async () => {})
    await act(async () => root.render(createElement(Harness, { refresh })))
    change([{ kind: 'create', absolutePath: '/repo/a.md' }])
    await advance(100)
    const latestChangeAt = performance.now()
    change([{ kind: 'create', absolutePath: '/repo/b.md' }])
    await advance(100)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(false, latestChangeAt)
  })

  it('keeps one slow scan in flight and follows up once it settles', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          setTimeout(() => {
            inFlight--
            resolve()
          }, 1000)
        })
    )
    await act(async () => root.render(createElement(Harness, { refresh })))
    // Watch batches arrive every 100 ms under sustained writes; each scan takes 1 s.
    for (let i = 0; i < 30; i++) {
      change([{ kind: 'create', absolutePath: `/repo/n${i}.md` }])
      await advance(100)
    }
    await advance(2000)
    expect(maxInFlight).toBe(1)
    // One scan per settled scan plus the trailing follow-up, not one per batch.
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('recovers from a scan that never settles', async () => {
    const refresh = vi
      .fn<(requireFresh: boolean, freshAfter: number) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockResolvedValue(undefined)
    await act(async () => root.render(createElement(Harness, { refresh })))
    // Local and UNC listings have no timeout; later changes must not stay frozen behind one.
    for (let i = 0; i < 20; i++) {
      change([{ kind: 'create', absolutePath: `/repo/h${i}.md` }])
      await advance(5_000)
    }
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('lets a slow scan publish while membership changes never stop', async () => {
    const scans: { startedAt: number; settledAt?: number }[] = []
    const refresh = vi.fn(() => {
      const scan: { startedAt: number; settledAt?: number } = {
        startedAt: Date.now()
      }
      scans.push(scan)
      // Why: a 40 s listing outlives the 30 s watchdog.
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          scan.settledAt = Date.now()
          resolve()
        }, 40_000)
      )
    })
    await act(async () => root.render(createElement(Harness, { refresh })))
    for (let i = 0; i < 60; i++) {
      change([{ kind: 'create', absolutePath: `/repo/s${i}.md` }])
      await advance(5_000)
    }
    // A scan's result publishes only if no newer scan started before it settled.
    const published = scans.filter(
      (scan, index) =>
        scan.settledAt !== undefined &&
        scans.slice(index + 1).every((later) => later.startedAt >= scan.settledAt!)
    )
    expect(published.length).toBeGreaterThanOrEqual(2)
  })
})

describe('Markdown membership freshness lifetime', () => {
  const refresh = async (): Promise<void> => {}

  it('preserves a change across unmount and remount until the exact join deadline', async () => {
    const worktreePath = '/lifetime/remount'
    await act(async () => root.render(createElement(Harness, { refresh, worktreePath })))
    const changedAt = performance.now()
    change([{ kind: 'create', absolutePath: `${worktreePath}/new.md` }], worktreePath)
    await act(async () => root.render(null))
    await advance(MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS - 1)
    expect(getLatestMarkdownMembershipChangeAt(null, worktreePath)).toBe(changedAt)

    await act(async () => root.render(createElement(Harness, { refresh, worktreePath })))
    expect(getLatestMarkdownMembershipChangeAt(null, worktreePath)).toBe(changedAt)
    await advance(1)
    expect(getLatestMarkdownMembershipChangeAt(null, worktreePath)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a renewed change until its own deadline after the old deadline passes', async () => {
    const worktreePath = '/lifetime/renewed'
    await act(async () => root.render(createElement(Harness, { refresh, worktreePath })))
    change([{ kind: 'create', absolutePath: `${worktreePath}/first.md` }], worktreePath)
    await advance(10_000)
    const changedAt = performance.now()
    change([{ kind: 'delete', absolutePath: `${worktreePath}/first.md` }], worktreePath)
    await act(async () => root.render(null))

    await advance(20_000)
    expect(getLatestMarkdownMembershipChangeAt(null, worktreePath)).toBe(changedAt)
    await advance(9_999)
    expect(getLatestMarkdownMembershipChangeAt(null, worktreePath)).toBe(changedAt)
    await advance(1)
    expect(getLatestMarkdownMembershipChangeAt(null, worktreePath)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires another root on time when the previously oldest root changes again', async () => {
    const firstPath = '/lifetime/ordered-first'
    const secondPath = '/lifetime/ordered-second'
    await act(async () => root.render(createElement(Harness, { refresh, worktreePath: firstPath })))
    change([{ kind: 'overflow', absolutePath: firstPath }], firstPath)
    await advance(10)
    await act(async () =>
      root.render(createElement(Harness, { refresh, worktreePath: secondPath }))
    )
    change([{ kind: 'overflow', absolutePath: secondPath }], secondPath)
    await advance(10)
    await act(async () => root.render(createElement(Harness, { refresh, worktreePath: firstPath })))
    const renewedAt = performance.now()
    change([{ kind: 'overflow', absolutePath: firstPath }], firstPath)
    await act(async () => root.render(null))

    await advance(MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS - 10)
    expect(getLatestMarkdownMembershipChangeAt(null, secondPath)).toBeUndefined()
    expect(getLatestMarkdownMembershipChangeAt(null, firstPath)).toBe(renewedAt)
    await advance(10)
    expect(getLatestMarkdownMembershipChangeAt(null, firstPath)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves surviving siblings and expires different owners and roots independently', async () => {
    const worktreePath = '/lifetime/owners'
    const otherPath = '/lifetime/other-owner-root'
    const firstPane = createElement(Harness, {
      key: 'first',
      refresh,
      worktreePath,
      runtimeEnvironmentId: 'env-a'
    })
    const siblingPane = createElement(Harness, {
      key: 'sibling',
      refresh,
      worktreePath,
      runtimeEnvironmentId: ' env-a '
    })
    const otherOwner = createElement(Harness, {
      key: 'owner',
      refresh,
      worktreePath,
      runtimeEnvironmentId: 'env-b'
    })
    const otherRoot = createElement(Harness, {
      key: 'root',
      refresh,
      worktreePath: otherPath,
      runtimeEnvironmentId: 'env-a'
    })
    await act(async () =>
      root.render(createElement(Fragment, null, firstPane, siblingPane, otherOwner, otherRoot))
    )
    change([{ kind: 'overflow', absolutePath: worktreePath }], worktreePath, 'env-a')
    expect(getLatestMarkdownMembershipChangeAt('env-b', worktreePath)).toBeUndefined()
    expect(getLatestMarkdownMembershipChangeAt(null, worktreePath)).toBeUndefined()
    await advance(10)
    change([{ kind: 'overflow', absolutePath: worktreePath }], worktreePath, 'env-b')
    await advance(10)
    change([{ kind: 'overflow', absolutePath: otherPath }], otherPath, 'env-a')
    await act(async () =>
      root.render(createElement(Fragment, null, siblingPane, otherOwner, otherRoot))
    )
    expect(getLatestMarkdownMembershipChangeAt('env-a', worktreePath)).toBe(0)
    await advance(10)
    change([{ kind: 'overflow', absolutePath: worktreePath }], worktreePath, 'env-a')
    await act(async () => root.render(null))

    await advance(MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS - 20)
    expect(getLatestMarkdownMembershipChangeAt('env-b', worktreePath)).toBeUndefined()
    expect(getLatestMarkdownMembershipChangeAt('env-a', otherPath)).toBe(20)
    expect(getLatestMarkdownMembershipChangeAt(' env-a ', worktreePath)).toBe(30)
    await advance(10)
    expect(getLatestMarkdownMembershipChangeAt('env-a', otherPath)).toBeUndefined()
    expect(getLatestMarkdownMembershipChangeAt('env-a', worktreePath)).toBe(30)
    await advance(10)
    expect(getLatestMarkdownMembershipChangeAt('env-a', worktreePath)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not rearm expiry on unchanged reads and releases the final timer', async () => {
    const worktreePath = '/lifetime/reads'
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      await act(async () => root.render(createElement(Harness, { refresh, worktreePath })))
      change([{ kind: 'overflow', absolutePath: worktreePath }], worktreePath)
      await act(async () => root.render(null))
      const scheduled = setTimeoutSpy.mock.calls.length
      for (let index = 0; index < 10; index++) {
        expect(getLatestMarkdownMembershipChangeAt(null, worktreePath)).toBe(0)
      }
      expect(setTimeoutSpy).toHaveBeenCalledTimes(scheduled)
      await advance(MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS)
      expect(getLatestMarkdownMembershipChangeAt(null, worktreePath)).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it('rejects an expired marker even when its cleanup timer was delayed', async () => {
    const worktreePath = '/lifetime/delayed'
    await act(async () => root.render(createElement(Harness, { refresh, worktreePath })))
    change([{ kind: 'overflow', absolutePath: worktreePath }], worktreePath)
    await act(async () => root.render(null))
    const now = vi.spyOn(performance, 'now').mockReturnValue(MARKDOWN_DOCUMENT_LIST_JOIN_WINDOW_MS)
    try {
      expect(getLatestMarkdownMembershipChangeAt(null, worktreePath)).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      now.mockRestore()
    }
  })
})
