// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../shared/tab-types'
import * as structuredOwner from '@/runtime/structured-agent-session-owner'
import { findAgentMessageSenderChatTab } from './native-chat-agent-message-sender-label'

const initial = useAppStore.getState()
beforeEach(() => {
  useAppStore.setState({
    activeWorktreeId: 'workspace',
    activeWorkspaceExecutionHostId: 'local'
  })
})
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
})

it.each([100, 1000])(
  'shares host-qualified tab collision scans for %i distinct senders and repeated cards',
  (n) => {
    const tab = (id: number, host: 'local' | 'runtime:remote'): Tab => ({
      id: `${host}-${id}`,
      entityId: `session-${id}`,
      worktreeId: 'workspace',
      groupId: 'g',
      contentType: 'agent-session' as const,
      executionHostId: host,
      label: 'Chat',
      customLabel: null,
      color: null,
      sortOrder: id,
      createdAt: 0
    })
    let tabVisits = 0
    const bucket = new Proxy(
      Array.from({ length: n }, (_, i) => [tab(i, 'local'), tab(i, 'runtime:remote')]).flat(),
      {
        get(target, key) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            tabVisits++
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plain fixture data has no accessor overrides; methods retain the caller's proxy receiver and indexed reads remain counted.
          return target[key as keyof typeof target]
        }
      }
    )
    useAppStore.setState({ unifiedTabsByWorktree: { workspace: bucket } })
    const original = structuredOwner.structuredAgentSessionOwnerForTab
    const owner = vi
      .spyOn(structuredOwner, 'structuredAgentSessionOwnerForTab')
      .mockImplementation((...args) => original(...args))
    const state = useAppStore.getState()
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        expect(findAgentMessageSenderChatTab(state, `session-${i}`, 'local')?.id).toBe(`local-${i}`)
      }
    }
    expect(owner).toHaveBeenCalledTimes(n * 4)
    // Workspace/session index, per-bucket session index, and qualified collision index each walk 2N tabs once.
    expect(tabVisits).toBe(n * 6)
    owner.mockClear()
    tabVisits = 0
    useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:remote' })
    for (let i = 0; i < n; i++) {
      findAgentMessageSenderChatTab(useAppStore.getState(), `session-${i}`, 'local')
    }
    expect(owner).toHaveBeenCalledTimes(n * 3)
    expect(tabVisits).toBe(n * 2) // Only the owner-qualified index invalidates.
  }
)
