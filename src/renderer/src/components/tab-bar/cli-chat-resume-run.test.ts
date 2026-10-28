// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { runLegacyCliChatResume } from './cli-chat-resume-run'
import type { CliChatResumeSource } from './cli-chat-resume-source'

const mocks = vi.hoisted(() => {
  const live: { source: CliChatResumeSource | null } = { source: null }
  return {
    rpc: vi.fn(),
    launch: vi.fn(),
    report: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    live,
    state: {
      activeView: 'worktrees',
      groupsByWorktree: {},
      tabsByWorktree: { workspace: [{ id: 'tab', createdAt: 1 }] },
      terminalLayoutsByTabId: {
        tab: {
          root: { type: 'leaf', leafId: 'leaf' },
          ptyIdsByLeafId: { leaf: 'pty' }
        }
      }
    }
  }
})
vi.mock('sonner', () => ({ toast: { info: mocks.info, error: mocks.error } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionTargetForHost: () => ({ kind: 'local' })
}))
vi.mock('./cli-chat-resume-terminal-capture', () => ({
  captureSourceTerminal: async () => ({
    target: { kind: 'local' },
    handle: 'exact',
    incarnationId: 'incarnation',
    presentation: { identity: { ptyId: 'pty' } }
  })
}))
vi.mock('./cli-chat-resume-source', () => ({ resolveCliChatResumeSource: () => mocks.live.source }))
vi.mock('../right-sidebar/ai-vault-session-resume-in-chat-launch', () => ({
  adoptingAgentOnHost: async (agent: string) => agent
}))
vi.mock('./cli-chat-resume-feedback', () => ({ reportCliChatResumeFailure: mocks.report }))
vi.mock('@/lib/agent-session/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.launch
}))
vi.mock('@/lib/agent-session-launch-plan', () => ({
  adoptAgentSessionLaunchVerdict: (args: unknown) => args
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))

const source: CliChatResumeSource = {
  agent: 'codex',
  executionHostId: 'local',
  workspaceId: 'workspace',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  ptyId: 'pty',
  providerSessionId: 'conversation'
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.live.source = source
  mocks.state = {
    ...mocks.state,
    activeView: 'worktrees',
    tabsByWorktree: { workspace: [{ id: 'tab', createdAt: 1 }] }
  }
  mocks.rpc.mockResolvedValue({ stoppedPtyIds: ['pty'], postStopVerified: true })
  mocks.launch.mockReturnValue({
    settlement: Promise.resolve({ kind: 'structured', sessionId: 'same' })
  })
})

it('uses only the old ordinary exact-stop envelope and starts adoption after proven exit', async () => {
  const stopped = Promise.withResolvers<unknown>()
  mocks.rpc.mockReturnValue(stopped.promise)
  const running = runLegacyCliChatResume(source)
  await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce())
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'terminal.stopExact', {
    worktree: 'id:workspace',
    expectedPtyIds: ['pty'],
    targetOnly: true,
    keepHistory: true
  })
  // Ordinary stop may remove the source from the live map; that is no failure or busy refusal.
  mocks.live.source = null
  stopped.resolve({ stoppedPtyIds: ['pty'], postStopVerified: true })
  await running
  expect(mocks.launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      plan: expect.objectContaining({ resumeFrom: { providerSessionId: 'conversation' } })
    })
  )
  expect(mocks.error).not.toHaveBeenCalled()
  expect(mocks.info).toHaveBeenCalledOnce()
})

it.each([
  null,
  {},
  { ptyKilled: true },
  { stoppedPtyIds: ['other'], postStopVerified: true },
  { stoppedPtyIds: ['pty'], postStopVerified: false },
  { stoppedPtyIds: ['pty'], postStopVerified: true, remainingLivePtyIds: ['pty'] }
])('does not create on an insufficient old receipt %j', async (receipt) => {
  mocks.rpc.mockResolvedValue(receipt)
  await runLegacyCliChatResume(source)
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('could not confirm Codex stopped')
  )
})

it('reports an unconfirmed old Stop once and never launches after a lost Stop result', async () => {
  mocks.rpc.mockRejectedValue(new Error('raw stop transport failure'))
  await runLegacyCliChatResume(source)
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
    'Orca could not confirm Codex stopped. Check Codex in the original terminal, then try switching again.'
  )
})

it('lets a replacement source win while exact Stop is pending', async () => {
  mocks.rpc.mockImplementation(async () => {
    mocks.live.source = { ...source, ptyId: 'replacement' }
    return { stoppedPtyIds: ['pty'], postStopVerified: true }
  })
  await runLegacyCliChatResume(source)
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.error).not.toHaveBeenCalled()
})

it.each(['navigate', 'close'] as const)(
  'lets a later %s win while exact Stop is pending',
  async (action) => {
    mocks.rpc.mockImplementation(async () => {
      mocks.state =
        action === 'navigate'
          ? { ...mocks.state, activeView: 'settings' }
          : { ...mocks.state, tabsByWorktree: { workspace: [] } }
      return { stoppedPtyIds: ['pty'], postStopVerified: true }
    })
    await runLegacyCliChatResume(source)
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
  }
)
