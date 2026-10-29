// @vitest-environment happy-dom
import { getDefaultSettings } from '../../../../shared/constants'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault-search-types'
import type { AgentDotState } from '@/components/AgentStateDot'
import { AiVaultVirtualRow } from './AiVaultVirtualRow'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useAppStore } from '@/store'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import {
  lastVerifiedRuntimeStatus,
  type RuntimeHostStatusSnapshot
} from '../../../../shared/runtime-host-status'

const cliSession: AiVaultSession = {
  id: 'local:codex:session-1:/tmp/session-1.jsonl',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'session-1',
  title: 'CLI session',
  cwd: '/repo',
  branch: null,
  model: null,
  filePath: '/tmp/session-1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-09-17T00:00:00.000Z',
  messageCount: 1,
  totalTokens: 0,
  previewMessages: [{ role: 'user', text: 'Fix it', timestamp: null }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'codex resume session-1',
  subagent: null
}

afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
  vi.restoreAllMocks()
})

function sessionRowFixture(
  session: AiVaultSession,
  blocked = false,
  searchHit?: AiVaultSearchHit,
  searchHitHostLabels?: ReadonlyMap<string, string>,
  index = 0,
  resumeInChat = false,
  liveState: AgentDotState | null = null
) {
  const buildResumeStartup = vi.fn(() => ({ command: session.resumeCommand }))
  const onCopyResume = vi.fn()
  const onResume = vi.fn()
  const onResumeInNewCli = vi.fn()
  const getOriginalPaneTarget = vi.fn(() => null)
  const element = (
    <AiVaultVirtualRow
      row={{ type: 'session', groupKey: 'today', session }}
      index={index}
      start={index * 52}
      activeStickyHeaderIndex={null}
      measureElement={vi.fn()}
      collapsedGroups={new Set()}
      expandedSessionIds={new Set()}
      vaultScope="all"
      searchHits={searchHit ? new Map([[session.id, searchHit]]) : undefined}
      searchHitHostLabels={searchHitHostLabels}
      buildResumeStartup={buildResumeStartup}
      getOriginalPaneTarget={getOriginalPaneTarget}
      isStructuredSessionOpen={() => false}
      getSessionLiveState={() => liveState}
      getWorktreeInfo={() => null}
      getSessionResumeState={() => ({
        blocked,
        worktreeId: blocked ? null : 'worktree-1',
        usesSessionWorktree: false
      })}
      getSessionResumeActions={() => ({
        worktree: { worktreeId: null, disabled: true },
        newTab: { worktreeId: 'worktree-1', disabled: blocked }
      })}
      getSessionResumeInChat={() =>
        resumeInChat
          ? { available: true, workspaceId: 'worktree-1' }
          : { available: false, reason: 'already-structured' }
      }
      onToggleGroup={vi.fn()}
      onToggleSessionDetails={vi.fn()}
      onJumpToOriginalPane={vi.fn()}
      onJumpToWorktree={vi.fn()}
      onResume={onResume}
      onContinueInNewSession={vi.fn()}
      onResumeInNewChat={vi.fn()}
      onResumeInNewCli={onResumeInNewCli}
      onCopyResume={onCopyResume}
      onCopyId={vi.fn()}
      onCopyPath={vi.fn()}
      onOpenLog={vi.fn()}
      onRevealLog={vi.fn()}
      onOpenCwd={vi.fn()}
      onRequestDelete={vi.fn()}
    />
  )
  return {
    element,
    getOriginalPaneTarget,
    buildResumeStartup,
    onCopyResume,
    onResume,
    onResumeInNewCli
  }
}

function renderSession(
  session: AiVaultSession,
  blocked = false,
  searchHit?: AiVaultSearchHit,
  searchHitHostLabels?: ReadonlyMap<string, string>,
  liveState: AgentDotState | null = null
) {
  const fixture = sessionRowFixture(
    session,
    blocked,
    searchHit,
    searchHitHostLabels,
    0,
    false,
    liveState
  )
  render(<TooltipProvider>{fixture.element}</TooltipProvider>)
  return fixture
}

it('passes semantic status through the virtual row to the real glyph', () => {
  renderSession(cliSession, false, undefined, undefined, 'monitoring')
  expect(screen.getByLabelText('Monitoring background tasks')).toBeTruthy()
})

describe('AiVaultVirtualRow search hit source host', () => {
  it('names the host a hit came from when hits span several hosts', () => {
    renderSession(cliSession, false, undefined, new Map([['local', 'Local Mac']]))

    expect(screen.getByTitle('Found on Local Mac').textContent).toBe('Local Mac')
  })

  it('shows no host badge when every hit came from one host', () => {
    renderSession(cliSession)

    expect(screen.queryByTitle(/^Found on /)).toBeNull()
  })
})

describe('AiVaultVirtualRow resume command actions', () => {
  it('renders blocked IDE references without preparing an unsafe startup command', () => {
    const { buildResumeStartup } = renderSession(
      {
        ...cliSession,
        agent: 'antigravity',
        title: 'IDE reference on another host',
        filePath:
          '//wsl.localhost/Debian/home/example/.gemini/antigravity-ide/brain/id/transcript_full.jsonl'
      },
      true
    )
    expect(screen.getByText('IDE reference on another host')).toBeTruthy()
    expect(buildResumeStartup).not.toHaveBeenCalled()
  })

  it('keeps Copy Resume Command in overflow and context actions for CLI sessions', async () => {
    const { buildResumeStartup, onCopyResume } = renderSession(cliSession)
    const user = userEvent.setup()

    await user.click(screen.getByTestId('ai-vault-session-more-actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy Resume Command' }))
    expect(onCopyResume).toHaveBeenCalledExactlyOnceWith(cliSession, 'worktree-1')

    fireEvent.contextMenu(screen.getByText('CLI session'))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy Resume Command' }))
    expect(onCopyResume).toHaveBeenCalledTimes(2)
    expect(buildResumeStartup).toHaveBeenCalledTimes(2)
  })

  it('omits Copy Resume Command and legacy command preparation for native sessions', async () => {
    const nativeSession: AiVaultSession = {
      ...cliSession,
      id: 'local:codex:session-native:/tmp/session-native.jsonl',
      sessionId: 'session-native',
      title: 'Native session',
      structuredSession: { sessionId: 'session-native', workspaceId: 'worktree-1' }
    }
    const { buildResumeStartup, onCopyResume } = renderSession(nativeSession)
    const user = userEvent.setup()

    await user.click(screen.getByTestId('ai-vault-session-more-actions'))
    expect(screen.queryByRole('menuitem', { name: 'Copy Resume Command' })).toBeNull()
    await user.keyboard('{Escape}')

    fireEvent.contextMenu(screen.getByText('Native session'))
    expect(screen.queryByRole('menuitem', { name: 'Copy Resume Command' })).toBeNull()
    expect(onCopyResume).not.toHaveBeenCalled()
    expect(buildResumeStartup).not.toHaveBeenCalled()
  })

  it('opens a paired host native chat search hit that carries no resume command', async () => {
    const owner = { sessionId: 'session-native', workspaceId: 'worktree-1' }
    const session: AiVaultSession = {
      ...cliSession,
      id: 'runtime:paired:codex:session-1:',
      executionHostId: 'runtime:paired',
      title: 'Paired native chat',
      filePath: '',
      resumeCommand: '',
      structuredSession: owner
    }
    const hit: AiVaultSearchHit = {
      agent: 'codex',
      sessionId: 'session-1',
      title: 'Paired native chat',
      cwd: '/repo',
      branch: null,
      updatedAt: null,
      messageCount: 1,
      score: 1,
      source: { presence: 'present' },
      evidence: null,
      structuredSession: owner
    }
    const { onResume } = renderSession(session, false, hit)
    const user = userEvent.setup()

    fireEvent.contextMenu(screen.getByText('Paired native chat'))
    await user.click(await screen.findByRole('menuitem', { name: 'Resume in New Tab' }))
    expect(onResume).toHaveBeenCalledExactlyOnceWith(session, 'worktree-1')
  })
})

describe('AiVaultVirtualRow CLI surface actions', () => {
  const owner = { sessionId: 'chat-1', workspaceId: 'worktree-1' }

  it.each(['claude', 'codex'] as const)(
    'offers the ordinary CLI switch on an older host for a chat-owned %s row from both menus',
    async (agent) => {
      useAppStore.setState((state) => ({
        settings: {
          ...getDefaultSettings('/home/test'),
          ...state.settings,
          experimentalNativeChat: true
        }
      }))
      setLocalRuntimeCapabilitiesForTests([])
      const session: AiVaultSession = { ...cliSession, agent, structuredSession: owner }
      const { onResumeInNewCli, onResume } = renderSession(session)
      const user = userEvent.setup()

      await user.click(screen.getByTestId('ai-vault-session-more-actions'))
      await user.click(await screen.findByRole('menuitem', { name: 'Switch to CLI' }))
      expect(onResumeInNewCli).toHaveBeenCalledExactlyOnceWith(session, 'worktree-1')

      fireEvent.contextMenu(screen.getByText('CLI session'))
      await user.click(await screen.findByRole('menuitem', { name: 'Switch to CLI' }))
      expect(onResumeInNewCli).toHaveBeenCalledTimes(2)
      expect(onResume).not.toHaveBeenCalled()
    }
  )

  it.each([
    { name: 'a terminal row', session: cliSession },
    {
      name: 'a chat-owned row of an agent that cannot fork',
      session: { ...cliSession, agent: 'gemini' as const, structuredSession: owner }
    }
  ])('does not offer the fork on $name', async ({ session }) => {
    renderSession(session)
    const user = userEvent.setup()

    await user.click(screen.getByTestId('ai-vault-session-more-actions'))
    await screen.findByRole('menu')
    expect(screen.queryByRole('menuitem', { name: 'Resume in New Terminal' })).toBeNull()
  })
})

it.each([
  { rows: 10, hosts: 3 },
  { rows: 100, hosts: 3 },
  { rows: 10, hosts: 30 }
])(
  'isolates $rows mounted History rows across $hosts registered hosts',
  async ({ rows, hosts }) => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState((state) => ({
      settings: {
        ...getDefaultSettings('/home/test'),
        ...state.settings,
        experimentalNativeChat: true
      }
    }))
    setLocalRuntimeCapabilitiesForTests([])
    const getStatus = vi.fn()
    const previousApi = window.api
    Object.assign(window, {
      api: { ...previousApi, runtime: { ...previousApi?.runtime, getStatus } }
    })
    const environments = Array.from({ length: hosts }, (_, index) => ({
      id: `history-host-${index}`,
      name: `Host ${index}`,
      createdAt: 1,
      updatedAt: 1,
      pairingRevision: 1,
      lastUsedAt: null,
      runtimeId: `history-host-${index}`,
      preferredEndpointId: 'endpoint',
      endpoints: [
        { id: 'endpoint', kind: 'websocket' as const, label: 'Host', endpoint: 'ws://host' }
      ]
    }))
    useAppStore.getState().setRuntimeEnvironments(environments)
    const addressed = environments.at(-1)!.id
    const snapshot = (id: string, sequence: number, blocked = false): RuntimeHostStatusSnapshot => {
      const response = createCompatibleRuntimeStatusResponse(id)
      if (!response.ok) {
        throw new Error('Expected compatible status')
      }
      return {
        environmentId: id,
        pairingRevision: 1,
        sequence,
        checkedAt: sequence,
        transport: 'ready',
        verification: blocked ? 'blocked' : 'verified',
        status: {
          ...response.result,
          capabilities: ['agent-session.structured.switch.creation-settlement-v1:codex']
        }
      }
    }
    for (const environment of environments) {
      useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(environment.id, 1))
    }
    const fixtures = Array.from({ length: rows }, (_, index) =>
      sessionRowFixture(
        {
          ...cliSession,
          id: `history-${index}`,
          sessionId: `conversation-${index}`,
          title: `History ${index}`,
          executionHostId: `runtime:${index === 0 ? addressed : environments[0].id}`
        },
        false,
        undefined,
        undefined,
        index,
        true
      )
    )
    const commits = new Map<string, number>()
    const rendered = render(
      <TooltipProvider>
        {fixtures.map((fixture, index) => (
          <Profiler
            key={index}
            id={String(index)}
            onRender={(id) => {
              commits.set(id, (commits.get(id) ?? 0) + 1)
            }}
          >
            {fixture.element}
          </Profiler>
        ))}
      </TooltipProvider>
    )
    try {
      await act(async () => {})
      const user = userEvent.setup()
      await user.click(screen.getAllByTestId('ai-vault-session-more-actions')[0])
      const control = await screen.findByRole('menuitem', { name: 'Switch to native chat' })
      expect(control.getAttribute('data-disabled')).toBeNull()
      await act(async () => {})
      const clearCounts = () => {
        commits.clear()
        fixtures.forEach((fixture) => fixture.getOriginalPaneTarget.mockClear())
      }
      clearCounts()
      const registered = useAppStore.getState().runtimeEnvironments
      let membershipEntries = 0
      const originalSome = registered.some.bind(registered)
      const membership = vi.spyOn(registered, 'some').mockImplementation((predicate, thisArg) =>
        originalSome((value, index, array) => {
          membershipEntries += 1
          return predicate.call(thisArg, value, index, array)
        })
      )
      const status = useAppStore.getState().runtimeStatusByEnvironmentId.get(addressed)
      const learned = lastVerifiedRuntimeStatus(status)
      if (!learned?.capabilities) {
        throw new Error('Expected learned capabilities')
      }
      const capabilities = vi.spyOn(learned.capabilities, 'includes')
      await act(async () => {
        useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(environments[1].id, 2))
      })
      expect([...commits.values()]).toEqual([])
      expect(
        fixtures.every((fixture) => fixture.getOriginalPaneTarget.mock.calls.length === 0)
      ).toBe(true)
      const membershipLookups = membership.mock.calls.length
      const capabilityLookups = capabilities.mock.calls.length
      expect(membershipLookups).toBeGreaterThanOrEqual(rows)
      expect(membershipLookups).toBeLessThanOrEqual(16 * rows)
      expect(capabilityLookups).toBeGreaterThan(0)
      expect(capabilityLookups).toBeLessThanOrEqual(16)
      expect(membershipEntries).toBeGreaterThanOrEqual(membershipLookups)
      expect(membershipEntries).toBeLessThanOrEqual(membershipLookups * hosts)
      membership.mockClear()
      capabilities.mockClear()
      await act(async () => {
        useAppStore.setState({ activeWorktreeId: 'unused-workspace' })
      })
      expect([...commits.values()]).toEqual([])
      expect(
        fixtures.every((fixture) => fixture.getOriginalPaneTarget.mock.calls.length === 0)
      ).toBe(true)
      expect(membership).not.toHaveBeenCalled()
      const unusedSwitchLookups = capabilities.mock.calls.filter(
        ([capability]) =>
          capability === 'agent-session.structured.switch.creation-settlement-v1:codex'
      ).length
      expect(unusedSwitchLookups).toBe(0)
      const unusedDeleteLookups = capabilities.mock.calls.filter(
        ([capability]) => capability === 'aiVault.delete-session.v1'
      ).length
      expect(unusedDeleteLookups).toBe(1)
      await act(async () => {
        useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(addressed, 2, true))
      })
      expect(commits.get('0')).toBeGreaterThan(0)
      expect([...commits.keys()]).toEqual(['0'])
      expect(fixtures[0].getOriginalPaneTarget).toHaveBeenCalledTimes(1)
      expect(
        fixtures.slice(1).every((fixture) => fixture.getOriginalPaneTarget.mock.calls.length === 0)
      ).toBe(true)
      expect(
        screen
          .getByRole('menuitem', { name: 'Switch to native chat' })
          .getAttribute('data-disabled')
      ).not.toBeNull()
      clearCounts()
      await act(async () => {
        useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(addressed, 3))
      })
      expect([...commits.keys()]).toEqual(['0'])
      expect(
        screen
          .getByRole('menuitem', { name: 'Switch to native chat' })
          .getAttribute('data-disabled')
      ).toBeNull()
      expect(getStatus).not.toHaveBeenCalled()
      console.info('HISTORY_ROW_COUNTS', {
        rows,
        hosts,
        unrelatedRowCommits: 0,
        unrelatedWrapperRenders: 0,
        membershipLookups,
        membershipEntries,
        capabilityLookups,
        unusedSwitchLookups,
        unusedDeleteLookups
      })
    } finally {
      rendered.unmount()
      Object.assign(window, { api: previousApi })
    }
  }
)
