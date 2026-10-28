import { describe, expect, it, vi } from 'vitest'

// The desktop's server-list feed loads react-native; its timer never runs without a subscriber.
vi.mock('react-native', () => ({}))
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import {
  applyServerWorkspaces,
  NO_SERVER_WORKSPACES,
  type ServerWorkspaces
} from './server-workspaces'
import type { Worktree } from './workspace-list-types'

const host: MobileRelayHost = {
  hostId: 'runtime:env-1',
  label: 'Box',
  health: 'available',
  relay: 'ready'
}

function row(worktreeId: string, hostId: MobileRelayHost['hostId'] = host.hostId): Worktree {
  return {
    worktreeId,
    repoId: 'repo-1',
    hostId,
    repo: 'orca',
    branch: 'main',
    displayName: worktreeId,
    path: `/srv/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

describe('applyServerWorkspaces', () => {
  it('keeps the same hosts list when only the rows change', () => {
    const first = applyServerWorkspaces(NO_SERVER_WORKSPACES, { hosts: [host], rows: [[row('a')]] })
    const next = applyServerWorkspaces(first, {
      hosts: [{ ...host }],
      rows: [[row('a'), row('b')]]
    })
    expect(next.worktrees.map((worktree) => worktree.worktreeId)).toEqual(['a', 'b'])
    expect(next.hosts).toBe(first.hosts)
    const relabeled = applyServerWorkspaces(next, {
      hosts: [{ ...host, relay: 'unavailable' }],
      rows: [null]
    })
    expect(relabeled.hosts).not.toBe(first.hosts)
    expect(relabeled.worktrees).toEqual(next.worktrees)
    expect(
      applyServerWorkspaces(next, {
        hosts: [{ ...host }],
        rows: [[row('a'), row('b')]]
      })
    ).toBe(next)
  })

  it('keeps cached rows for failed servers with one ownership read per row', () => {
    const hosts = Array.from({ length: 20 }, (_, index): MobileRelayHost => ({
      ...host,
      hostId: `runtime:env-${index}`
    }))
    let ownershipReads = 0
    const previous: ServerWorkspaces = {
      hosts,
      worktrees: hosts.flatMap((server) =>
        ['a', 'b'].map((slot) => ({
          ...row(`${server.hostId}-${slot}`, server.hostId),
          get hostId() {
            ownershipReads += 1
            return server.hostId
          }
        }))
      )
    }
    const recovered = row('recovered', hosts[0]!.hostId)
    const nextHosts = hosts.slice(0, -1).map((server) => ({ ...server }))
    const next = applyServerWorkspaces(previous, {
      hosts: nextHosts,
      rows: nextHosts.map((_, index) => (index === 0 ? [recovered] : null))
    })
    const expected = [recovered, ...previous.worktrees.slice(2, -2)]
    expect(next.worktrees).toHaveLength(expected.length)
    expected.forEach((entry, index) => expect(next.worktrees[index]).toBe(entry))
    expect(ownershipReads).toBeLessThanOrEqual(previous.worktrees.length)
  })
})
