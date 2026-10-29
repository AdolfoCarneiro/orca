import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexPaneAccountRegistryMutations } from './codex-pane-account-registry-mutations'
import type { CodexPaneAccountRegistryFile } from './codex-pane-account-registry-types'

const EXISTING = {
  selectionKey: 'host',
  accountId: 'account-1',
  homeRoute: 'account-home'
} as const

const SPAWNED = {
  selectionKey: 'host',
  accountId: 'account-2',
  homeRoute: 'account-home'
} as const

function parseRegistry(serialized: string): CodexPaneAccountRegistryFile {
  return JSON.parse(serialized) as CodexPaneAccountRegistryFile
}

describe('CodexPaneAccountRegistryMutations', () => {
  beforeEach(() => vi.useFakeTimers())

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('retries a one-shot spawn record and merges it with the recovered file', async () => {
    let readable = false
    let persisted = JSON.stringify({ version: 2, panes: { existing: EXISTING } })
    const write = vi.fn((registry: CodexPaneAccountRegistryFile) => {
      persisted = JSON.stringify(registry)
      return true
    })
    const mutations = new CodexPaneAccountRegistryMutations({
      read: () => (readable ? parseRegistry(persisted) : null),
      write
    })

    mutations.record('spawned', SPAWNED)
    expect(write).not.toHaveBeenCalled()

    readable = true
    await vi.advanceTimersByTimeAsync(100)

    expect(parseRegistry(persisted).panes).toEqual({ existing: EXISTING, spawned: SPAWNED })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps one capped-delay retry until quiet IO recovers', async () => {
    let readable = false
    let persisted = JSON.stringify({ version: 2, panes: { existing: EXISTING } })
    const read = vi.fn(() => (readable ? parseRegistry(persisted) : null))
    const write = vi.fn((registry: CodexPaneAccountRegistryFile) => {
      persisted = JSON.stringify(registry)
      return true
    })
    const mutations = new CodexPaneAccountRegistryMutations({ read, write })

    mutations.record('spawned', SPAWNED)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(read.mock.calls.length).toBeGreaterThan(5)
    expect(vi.getTimerCount()).toBe(1)

    readable = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(parseRegistry(persisted).panes.spawned).toEqual(SPAWNED)
  })

  it('retries durability after a write failure even when the cached value now matches', async () => {
    const registry = parseRegistry(JSON.stringify({ version: 2, panes: { existing: EXISTING } }))
    const write = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const mutations = new CodexPaneAccountRegistryMutations({ read: () => registry, write })

    mutations.record('spawned', SPAWNED)
    await vi.advanceTimersByTimeAsync(100)

    expect(write).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a failed reconciliation write without a pending pane mutation', async () => {
    const registry = parseRegistry(JSON.stringify({ version: 2, panes: { existing: EXISTING } }))
    const write = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const mutations = new CodexPaneAccountRegistryMutations({ read: () => registry, write })

    mutations.persistReconciliation(registry, true)
    await vi.advanceTimersByTimeAsync(100)

    expect(write).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('whole birth projection durability', () => {
  it('retains more than 2000 latest mutations and replaces provenance atomically', () => {
    let readable = false
    let disk = JSON.stringify({ version: 2, panes: {} })
    const mutations = new CodexPaneAccountRegistryMutations({
      read: () => (readable ? parseRegistry(disk) : null),
      write: (registry) => {
        disk = JSON.stringify(registry)
        return true
      }
    })
    for (let i = 0; i < 2001; i++) {
      mutations.record(String(i), {
        ...SPAWNED,
        launchProvenance: { homePath: '/actual/O', incarnationId: `birth-${i}` }
      })
    }
    readable = true
    mutations.flush()
    expect(Object.keys(parseRegistry(disk).panes)).toHaveLength(2001)
    mutations.record('0', {
      ...EXISTING,
      launchProvenance: { homePath: '/replacement/O', incarnationId: 'next' }
    })
    expect(parseRegistry(disk).panes['0']).toEqual({
      ...EXISTING,
      launchProvenance: { homePath: '/replacement/O', incarnationId: 'next' }
    })
    mutations.record('0', EXISTING)
    expect(parseRegistry(disk).panes['0']).toEqual(EXISTING)
    mutations.reset()
  })
})

it('measures full-row writes at N/10N without hiding sequential full-file cost', () => {
  const counts = []
  for (const population of [8, 80]) {
    const registry: CodexPaneAccountRegistryFile = { version: 2, panes: {} }
    let writes = 0,
      bytes = 0
    const mutations = new CodexPaneAccountRegistryMutations({
      read: () => registry,
      write: (value) => {
        writes++
        bytes += Buffer.byteLength(JSON.stringify(value))
        return true
      }
    })
    for (let i = 0; i < population; i++) {
      mutations.record(String(i), {
        ...SPAWNED,
        launchProvenance: { homePath: '/actual/O', incarnationId: `birth-${i}` }
      })
    }
    expect(Object.keys(registry.panes)).toHaveLength(population)
    expect(writes).toBe(population)
    counts.push({ population, writes, bytes })
    mutations.reset()
  }
  expect(counts[1].bytes).toBeGreaterThan(counts[0].bytes * 10)
  expect(counts[1].bytes).toBeLessThan(counts[0].bytes * 110)
  console.warn('registry-production-N10N', JSON.stringify(counts))
})
