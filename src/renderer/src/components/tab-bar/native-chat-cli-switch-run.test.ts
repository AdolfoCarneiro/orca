import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../shared/structured-agent-session-reducer'
import type { StructuredAgentSessionReadSnapshot } from '@/components/native-chat/structured-agent-session-read-owner-contract'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const live: { held?: StructuredAgentSessionReadSnapshot; view: string } = { view: 'worktrees' }
  return {
    supported: true,
    live,
    call: vi.fn(),
    launch: vi.fn((_args: unknown): { tabId: string | null; runtimeLaunch?: Promise<unknown> } => ({
      tabId: 'terminal-tab'
    })),
    closeUnifiedTab: vi.fn(),
    toast: vi.fn()
  }
})
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
vi.mock('@/store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: () => ({
      settings: {},
      closeUnifiedTab: mocks.closeUnifiedTab,
      activeView: mocks.live.view
    })
  }
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  subscribeLocalRuntimeCapabilityObservation: () => () => {},
  readLocalRuntimeCapabilitiesOrUnknown: () => [],
  ensureLocalRuntimeCapabilities: async () =>
    mocks.supported
      ? ['agent-session.structured.switch.v1:codex', 'agent-session.conversation-stop.v1']
      : []
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: async () => false
}))
vi.mock('@/components/native-chat/structured-agent-session-read-owner-registry', () => ({
  findStructuredAgentSessionReadOwner: () =>
    mocks.live.held ? { getSnapshot: () => mocks.live.held } : undefined
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsInPlaceSwitch: async () => mocks.supported,
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({ getExecutionHostIdForWorktree: () => 'local' }))
vi.mock('@/lib/launch-ai-vault-session', () => ({ launchAiVaultSessionInNewTab: mocks.launch }))
vi.mock('@/lib/ai-vault-resume-command', () => ({
  buildAiVaultResumeStartupForWorktree: () => ({
    command: 'codex resume thread-c',
    env: { CODEX_HOME: '/accounts/a/home' },
    providerSession: { key: 'session_id', id: 'thread-c' }
  })
}))

import { runLegacyNativeChatCliSwitch as runNativeChatCliSwitch } from './native-chat-cli-switch-run'

const SWITCH = {
  sessionId: 'chat-1',
  workspaceId: 'wt-1',
  executionHostId: 'local',
  agent: 'codex' as const,
  chatTabId: 'chat-tab'
}
const SOURCE = {
  agent: 'codex',
  sourceAgent: 'codex',
  sessionId: 'thread-c',
  filePath: '/accounts/a/home/sessions/rollout-thread-c.jsonl',
  cwd: '/repo',
  codexHome: '/accounts/a/home',
  executionHostPlatform: 'darwin'
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.supported = true
  mocks.live.held = undefined
  mocks.live.view = 'worktrees'
  mocks.call.mockResolvedValue({ source: SOURCE })
})

it('stops the chat on its host, opens the same-id resume in its slot, leaves retirement to the admitted host launch', async () => {
  await runNativeChatCliSwitch(SWITCH)
  expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.switchToTerminal', {
    sessionId: 'chat-1'
  })
  expect(mocks.launch).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'codex',
      worktreeId: 'wt-1',
      command: 'codex resume thread-c',
      env: { CODEX_HOME: '/accounts/a/home' },
      providerSession: { key: 'session_id', id: 'thread-c' },
      afterTabId: 'chat-tab',
      resumeOrigin: 'switch'
    })
  )
  // The committed host launch hides the source; a client receipt never stops today's native child.
  expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
})

it('preserves readable recovery and never launches from an old Close acknowledgement', async () => {
  mocks.supported = false
  await runNativeChatCliSwitch(SWITCH)
  expect(mocks.call.mock.calls.map((call) => call[1])).toEqual([
    'agentSession.close',
    'agentSession.reveal'
  ])
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenCalledOnce()
})

it('keeps the chat when old owner cannot complete Stop, with factual guidance', async () => {
  mocks.call.mockRejectedValue({
    data: {
      refusal: { code: 'agent_session_ownership_unknown', details: { reason: 'ownerUnproven' } }
    }
  })
  await runNativeChatCliSwitch(SWITCH)
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.stringContaining('could not confirm Codex stopped')
  )
})

it('composes ordinary Stop before the old strict proven-close switch envelope', async () => {
  mocks.live.held = {
    current: true,
    loadingOlder: false,
    olderHistoryGeneration: 0,
    state: {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      fence: 8,
      working: true,
      latestTurn: { itemId: 'turn', observedAt: 1, turn: { turnId: 'turn', state: 'running' } }
    }
  }
  const stop = Promise.withResolvers<{ ok: boolean }>()
  mocks.call.mockImplementation((_target, method) =>
    method === 'agentSession.cancel' ? stop.promise : Promise.resolve({ source: SOURCE })
  )
  const switching = runNativeChatCliSwitch(SWITCH)
  await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.call.mock.calls[0][2]).toEqual({
    envelope: expect.objectContaining({
      sessionId: SWITCH.sessionId,
      expectedRuntimeFence: 8
    })
  })
  stop.resolve({ ok: true })
  await switching
  expect(mocks.call.mock.calls.map((call) => call[1])).toEqual([
    'agentSession.cancel',
    'agentSession.switchToTerminal'
  ])
  expect(mocks.call.mock.calls[1][2]).toEqual({ sessionId: SWITCH.sessionId })
  expect(mocks.launch).toHaveBeenCalledOnce()
})

it('does not override navigation while the old proven-close owner is pending', async () => {
  mocks.call.mockImplementation(async () => {
    mocks.live.view = 'settings'
    return { source: SOURCE }
  })
  await runNativeChatCliSwitch(SWITCH)
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.toast).not.toHaveBeenCalled()
})
