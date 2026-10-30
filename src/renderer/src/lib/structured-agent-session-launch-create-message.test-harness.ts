import { vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../shared/agent-session-wire'
import {
  CreateIntentParams,
  SendParams
} from '../../../shared/rpc-contract/structured-agent-session-params'
import type { Tab } from '../../../shared/tab-types'
import type { HostCreateSupport } from './structured-agent-session-host-admission'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { readNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'

const mocks = vi.hoisted(() => {
  const settings: Record<string, unknown> = {}
  return {
    rpc: vi.fn(),
    hostBusy: false,
    tabs: [] as Tab[],
    call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>(),
    supports: vi.fn<() => Promise<boolean>>(),
    supportsMode: vi.fn<() => Promise<boolean>>(),
    admit: vi.fn<() => Promise<HostCreateSupport>>(),
    inventory: vi.fn(),
    settings
  }
})
const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))
// This machine's host closes the chat's tab when asked.
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    getSnapshot: () => ({
      get: () => ({ status: mocks.hostBusy ? 'working' : 'idle', hostExecutionPhase: 'idle' })
    }),
    getSessionObservation: () => 'live'
  })
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionCreateOptionsMode: mocks.supportsMode,
  supportsStructuredAgentSessionCreateMessage: mocks.supports
}))
vi.mock('./structured-agent-session-host-admission', () => ({
  askHostCreateSupport: mocks.admit
}))
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: mocks.inventory
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: mocks.settings,
      unifiedTabsByWorktree: { 'workspace-1': mocks.tabs },
      agentStatusByPaneKey: {},
      runtimeStatusByEnvironmentId: new Map(),
      groupsByWorktree: {},
      seedNativeChatLaunchDraft: vi.fn(),
      clearNativeChatLaunchDraft: vi.fn()
    }),
    subscribe: () => () => {}
  }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-chat-host-permission', () => ({
  readStructuredChatHostPermissionVerdict: async () => ({ kind: 'allowed' })
}))

function deferred<T>() {
  return Promise.withResolvers<T>()
}
function createParams() {
  return CreateIntentParams.parse(
    mocks.call.mock.calls.find(([, method]) => method === 'agentSession.create')?.[2]
  )
}
function submission(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'a'.repeat(64),
    dispatchState: 'pending',
    handoverRecorded: true,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}
function created(params = createParams()) {
  const rows = params.firstMessage ? [submission(params.firstMessage.clientMessageId)] : []
  const cursor = { epoch: 'epoch-1', sequence: rows.length }
  const page: AgentSessionHistoryPage = {
    sessionId: params.envelope.sessionId,
    epoch: cursor.epoch,
    fence: 1,
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: rows,
    window: { oldest: null, newest: null, nextCursor: cursor },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false,
    latestTurn: null
  }
  return {
    ok: true,
    replayed: false,
    value: { sessionId: page.sessionId, fence: 1, page, unconfirmedClientMessageIds: [] }
  }
}
const target = { kind: 'local' } as const
const start = () =>
  startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local',
    prompt: 'opening text'
  })
const draft = (sessionId: string) =>
  readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(sessionId))

// An older host (no create-message) applies an action's explicit options one setOption at a time.
function startLegacyActionLaunch(
  launchOptions: Record<string, string>,
  refusedKey: string,
  refusal: Record<string, unknown>
) {
  mocks.supports.mockResolvedValue(false)
  mocks.call.mockImplementation(async (_target, method, params) => {
    if (method === 'agentSession.create') {
      return created()
    }
    if (method === 'agentSession.setOption') {
      const key = params && typeof params === 'object' && 'key' in params ? params.key : null
      return key === refusedKey
        ? { ok: false, refusal }
        : { ok: true, value: { options: { model: launchOptions.model } } }
    }
    const send = SendParams.parse(params)
    const clientMessageId = send.envelope.clientOperationId
    return { ok: true, value: { clientMessageId, submission: submission(clientMessageId) } }
  })
  const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local',
    prompt: 'opening text',
    launchOptions
  })
  mocks.inventory.mockResolvedValue([
    { worktree: 'workspace-1', tabs: [{ type: 'agent-session', sessionId: launch.sessionId }] }
  ])
  return launch
}

export {
  mocks,
  layoutOwner,
  deferred,
  createParams,
  submission,
  created,
  target,
  start,
  draft,
  startLegacyActionLaunch
}
