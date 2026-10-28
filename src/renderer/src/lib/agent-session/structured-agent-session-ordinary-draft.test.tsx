// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type * as structuredSessionClient from '@/runtime/structured-agent-session-client'
import { adoptAgentSessionLaunchVerdict } from '../agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from './structured-agent-session-provisional-tab'
import {
  getStructuredLaunchStateBySessionId,
  hasStructuredAgentSessionLaunchCancellationTombstone,
  resetStructuredAgentLaunchRegistryForTests
} from './launch/structured-agent-session-launch-registry'
import { hasStagedStructuredLaunchPrompt } from '../structured-agent-session-launch-prompt'
import { wasStructuredAgentLaunchClosedByLocalCancel } from '../structured-agent-session-local-launch-cancel'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  nativeChatPendingAttachmentSnapshot
} from '@/components/native-chat/native-chat-pending-attachment-cache'
import { promptTextContent } from '@/components/native-chat/native-chat-prompt-document-text'
import { useNativeChatDraft } from '@/components/native-chat/use-native-chat-draft'
import { CreateIntentParams } from '../../../../shared/rpc-contract/structured-agent-session-params'

const rpc = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>()
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('@/runtime/structured-agent-session-client', async (original) => ({
  ...(await original<typeof structuredSessionClient>()),
  callStructuredAgentSession: rpc.call,
  supportsStructuredAgentSessionCreateMessage: async () => false
}))
vi.mock('../structured-agent-session-host-admission', () => ({
  askHostCreateSupport: async () => ({ kind: 'allowed' })
}))
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: async () => []
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))

let main: TabsDrawnFromMain
let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
  resetStructuredAgentLaunchRegistryForTests()
  storage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    tabsByWorktree: {},
    tabBarOrderByWorktree: {}
  })
  main = await drawTabsFromMain(useAppStore)
})
afterEach(() => main.close())

it.each(['close', 'cancel', 'abort', 'edited-close'] as const)(
  'keeps a nonresume Hand Off through actual %s and late create settlement',
  async (action) => {
    const creation = Promise.withResolvers<unknown>()
    rpc.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.create') {
        return creation.promise
      }
      if (method === 'agentSession.close') {
        return Promise.resolve({ ok: true })
      }
      throw new Error(`Unexpected provider operation ${method}`)
    })
    const controller = new AbortController()
    const text = 'Hand Off context\nwith exact trailing bytes  '
    const plan = adoptAgentSessionLaunchVerdict({
      requestId: `early-${action}`,
      route: 'structured-native-chat',
      agent: 'claude',
      worktreeId: 'wt-1',
      executionHostId: 'local',
      prompt: text,
      promptDelivery: 'draft'
    })
    const handle = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: { signal: controller.signal },
      focusIntent: { request: vi.fn(), cancel: vi.fn() }
    })
    if (!handle?.tab) {
      throw new Error('Expected a provisional source')
    }
    const { tab } = handle
    const scope = structuredAgentSessionDraftScopeKey(handle.sessionId)
    await main.settle()
    await vi.waitFor(() =>
      expect(rpc.call.mock.calls.some(([, method]) => method === 'agentSession.create')).toBe(true)
    )
    const params = CreateIntentParams.parse(
      rpc.call.mock.calls.find(([, method]) => method === 'agentSession.create')?.[2]
    )
    expect(params.resumeFrom).toBeUndefined()
    expect(params.firstMessage).toBeUndefined()
    expect(hasStagedStructuredLaunchPrompt(handle.sessionId)).toBe(false)
    expect(readNativeChatComposerDraft(scope)).toMatchObject({
      text,
      document: promptTextContent(text),
      owner: { workspaceId: 'wt-1', executionHostId: 'local' }
    })
    const edited = action === 'edited-close'
    const expectedText = edited ? 'my later text' : text
    const expectedDocument = edited
      ? { ...promptTextContent(expectedText), attrs: { edited: true } }
      : promptTextContent(text)
    if (edited) {
      updateNativeChatComposerDraft(
        scope,
        {
          text: expectedText,
          document: expectedDocument,
          images: [{ id: 'kept', path: '/repo/kept.png' }]
        },
        'immediate'
      )
      addNativeChatPendingAttachment(scope, { id: 'pending', path: '', pending: true })
    }
    if (action === 'cancel') {
      handle.cancel()
    } else if (action === 'abort') {
      controller.abort()
    } else {
      useAppStore.getState().closeUnifiedTab(tab.id)
    }
    await main.settle()
    const remainingIds = (useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []).map(
      (row) => row.id
    )
    expect(readNativeChatComposerDraft(scope).text).toBe(expectedText)
    expect(readNativeChatComposerDraft(scope).document).toEqual(expectedDocument)
    expect(
      ORCA_LAYOUT_OWNER_IS_MAIN
        ? wasStructuredAgentLaunchClosedByLocalCancel(handle.sessionId)
        : hasStructuredAgentSessionLaunchCancellationTombstone('wt-1', handle.sessionId)
    ).toBe(true)
    creation.resolve({
      ok: true,
      value: { sessionId: handle.sessionId, fence: 1, page: { submissions: [] } }
    })
    expect((await handle.settlement).kind).not.toBe('structured')
    await main.settle()
    expect(getStructuredLaunchStateBySessionId(handle.sessionId)).toBeUndefined()
    expect(
      (useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []).map((row) => row.id)
    ).toEqual(remainingIds)
    if (action.endsWith('close')) {
      expect(useAppStore.getState().getTab(tab.id)).toBeNull()
    }
    expect(
      rpc.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
    ).toHaveLength(1)
    expect(
      rpc.call.mock.calls.every(
        ([, method]) => method === 'agentSession.create' || method === 'agentSession.close'
      )
    ).toBe(true)
    if (edited) {
      expect(nativeChatPendingAttachmentSnapshot(scope)).toHaveLength(1)
    }
    await nativeChatComposerDraftWritesSettled()
    expect(storage.drafts.get(scope)).toMatchObject({
      text: expectedText,
      document: expectedDocument,
      owner: { workspaceId: 'wt-1', executionHostId: 'local' }
    })
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    const reader = renderHook(() => useNativeChatDraft(scope, () => false))
    expect(reader.result.current.draft).toBe(expectedText)
    expect(readNativeChatComposerDraft(scope).document).toEqual(expectedDocument)
    if (edited) {
      expect(readNativeChatComposerDraft(scope).images).toEqual([
        { id: 'kept', path: '/repo/kept.png' }
      ])
    }
    reader.unmount()
    await act(async () => {})
  }
)
