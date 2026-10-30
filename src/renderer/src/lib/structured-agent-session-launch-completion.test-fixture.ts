import { expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { beginStructuredAgentLaunchSettlement } from './structured-agent-launch-settlement'
import {
  getStructuredAgentLaunchStatus,
  hasStructuredAgentLaunchInWorktree
} from './structured-agent-session-launch-status'
import { admitStructuredAgentSession } from './agent-session/structured-agent-session-busy'
import { renderHook } from '@testing-library/react'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/use-native-chat-provisional-launch'
import { structuredSessionNotices } from '@/components/native-chat/native-chat-structured-session-notices'
import { getStructuredLaunchStateBySessionId } from './agent-session/launch/structured-agent-session-launch-registry'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import {
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice
} from '@/components/native-chat/structured-agent-session-pending-sends'
import { readStructuredAgentLaunchRecord } from './agent-session/launch/structured-agent-session-launch-persistence'
import { settleStructuredAgentSessionSendsFromJournal } from '@/components/native-chat/structured-agent-session-message-sender'
import { holdStructuredAgentSessionLaunchOption } from './structured-agent-session-launch-options'
import { writeNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import {
  mocks,
  deferred,
  createParams,
  created,
  draft
} from './structured-agent-session-launch-create-message.test-harness'

export function registerCreateCompletionTests(): void {
  it.each(['reply', 'journal'] as const)(
    'ends create callers at deadline and joins late exact %s proof without restarting callbacks',
    async (proof) => {
      const create = deferred<unknown>()
      mocks.call.mockReturnValue(create.promise)
      const ready = vi.fn()
      const delivered = vi.fn()
      const signal = new AbortController()
      const removed = vi.spyOn(signal.signal, 'removeEventListener')
      const launch = beginStructuredAgentLaunchSettlement(
        'workspace-1',
        'codex',
        {
          requestId: newAgentLaunchRequestId(),
          executionHostId: 'local',
          prompt: 'opening text',
          onPromptDelivered: delivered
        },
        { onStructuredReady: ready, signal: signal.signal }
      )
      const completed = vi.fn()
      void launch.settlement.then(completed)
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
      const original = createParams()
      const raw = getStructuredLaunchStateBySessionId(launch.sessionId)?.promise
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(launch.settlement).resolves.toEqual({
        kind: 'visibility-unknown',
        sessionId: launch.sessionId
      })
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({
        delivered: false,
        unconfirmed: true
      })
      expect(completed).toHaveBeenCalledOnce()
      expect(ready).not.toHaveBeenCalled()
      expect(delivered).not.toHaveBeenCalled()
      expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(getStructuredAgentLaunchStatus('workspace-1', 'codex')).toBe('idle')
      expect(hasStructuredAgentLaunchInWorktree('workspace-1')).toBe(false)
      const tab: Tab = {
        id: 'opening-tab',
        entityId: launch.sessionId,
        contentType: 'agent-session',
        executionHostId: 'local',
        worktreeId: 'workspace-1',
        groupId: 'group-1',
        label: 'Codex Chat',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
      mocks.tabs = [tab]
      const hostPage = {
        ...created().value.page,
        working: false,
        actionablePromptIds: [],
        backgroundTasks: null,
        nextQueuedMessageId: null
      }
      mocks.rpc.mockResolvedValue({ ok: true, page: hostPage })
      const admission = vi.fn()
      await admitStructuredAgentSession('workspace-1', tab, 'close-idle', (busy) => {
        admission(busy)
      })
      expect(admission).toHaveBeenLastCalledWith(false)
      mocks.hostBusy = true
      await admitStructuredAgentSession('workspace-1', tab, 'close-working', (busy) => {
        admission(busy)
      })
      expect(admission).toHaveBeenLastCalledWith(true)
      mocks.hostBusy = false
      mocks.rpc.mockResolvedValue({
        ok: true,
        page: { ...hostPage, nextQueuedMessageId: 'real-queue' }
      })
      await admitStructuredAgentSession('workspace-1', tab, 'close-queue', (busy) => {
        admission(busy)
      })
      expect(admission).toHaveBeenLastCalledWith(true)

      const view = renderHook(() => useNativeChatProvisionalLaunch('workspace-1', launch.sessionId))
      expect(view.result.current).toMatchObject({
        starting: false,
        transportEnabled: true,
        lifecycle: null
      })
      expect(
        structuredSessionNotices({
          launch: view.result.current,
          agentLabel: 'Codex',
          sessionError: null,
          composerError: null
        })
      ).toEqual([])
      expect(getStructuredAgentSessionSendNotice(launch.sessionId)).toBeNull()
      expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toMatchObject([
        {
          clientMessageId: original.firstMessage?.clientMessageId,
          body: original.firstMessage?.body,
          phase: 'unconfirmed'
        }
      ])
      expect(readStructuredAgentLaunchRecord(launch.sessionId)?.firstMessage).toEqual(
        original.firstMessage
      )
      writeNativeChatDraftCache(
        structuredAgentSessionDraftScopeKey(launch.sessionId),
        'newer draft'
      )
      const response = created()
      if (proof === 'journal') {
        settleStructuredAgentSessionSendsFromJournal(
          launch.sessionId,
          response.value.page.submissions,
          [],
          response.value.page.liveCursor
        )
      }
      create.resolve(response)
      await raw
      await vi.waitFor(() =>
        expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toEqual([])
      )
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
      expect(completed).toHaveBeenCalledOnce()
      expect(ready).not.toHaveBeenCalled()
      expect(delivered).not.toHaveBeenCalled()
      expect(getStructuredAgentLaunchStatus('workspace-1', 'codex')).toBe('idle')
      expect(draft(launch.sessionId)).toBe('newer draft')
      expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
      view.unmount()
    }
  )

  it('settles an exact journal receipt before an unanswered create reply, without waiting on that RPC', async () => {
    const create = deferred<unknown>()
    const option = deferred<unknown>()
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.create' ? create.promise : option.promise
    )
    const ready = vi.fn()
    const delivered = vi.fn()
    const launch = beginStructuredAgentLaunchSettlement(
      'workspace-1',
      'codex',
      {
        requestId: newAgentLaunchRequestId(),
        executionHostId: 'local',
        prompt: 'opening text',
        onPromptDelivered: delivered
      },
      { onStructuredReady: ready }
    )
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const raw = getStructuredLaunchStateBySessionId(launch.sessionId)?.promise
    const picked = holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'later-model')
    const response = created()
    settleStructuredAgentSessionSendsFromJournal(
      launch.sessionId,
      response.value.page.submissions,
      [],
      response.value.page.liveCursor
    )
    await expect(launch.settlement).resolves.toMatchObject({
      kind: 'structured',
      sessionId: launch.sessionId
    })
    expect(ready).toHaveBeenCalledOnce()
    expect(delivered).toHaveBeenCalledOnce()
    writeNativeChatDraftCache(structuredAgentSessionDraftScopeKey(launch.sessionId), 'newer draft')
    create.resolve(response)
    await raw
    expect(ready).toHaveBeenCalledOnce()
    expect(delivered).toHaveBeenCalledOnce()
    expect(draft(launch.sessionId)).toBe('newer draft')
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.create',
      'agentSession.setOption'
    ])
    option.resolve({ ok: true, value: { options: { model: 'later-model' } } })
    await expect(picked).resolves.toMatchObject({ kind: 'accepted' })
  })
}
