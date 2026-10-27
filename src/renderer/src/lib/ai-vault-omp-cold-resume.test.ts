import { resolveTerminalHostOwnership } from './terminal-worktree-route'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { materializeAiVaultResumeForTest } from './ai-vault-resume-startup.test-fixture'
import { buildAiVaultCopiedSessionStartupForWorktree } from './ai-vault-session-fork-startup'
import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { createTestStore, makeTab } from '@/store/slices/store-test-helpers'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import { buildAiVaultResumeStartupForWorktree } from './ai-vault-resume-command'

describe('AI Vault OMP cold resume', () => {
  it('preserves local OpenCode standalone mode and existing custom host settings', async () => {
    const store = createTestStore()
    const state = store.getState()
    Object.assign(state, {
      settings: {
        agentDefaultArgs: { opencode: '--model synthetic-model' },
        agentDefaultEnv: {
          opencode: {
            OPENCODE_AUTH_CONTENT: 'synthetic-local-auth',
            HOME: '/host-home',
            OPENCODE_CONFIG_DIR: '/host-config'
          }
        }
      }
    })
    const startup = buildAiVaultCopiedSessionStartupForWorktree(
      {
        state,
        session: {
          agent: 'opencode',
          sessionId: 'copy-session',
          cwd: '/repo',
          codexHome: null,
          executionHostId: 'local'
        }
      },
      'opencode2'
    )
    const effective = await materializeAiVaultResumeForTest(
      {
        state,
        session: { agent: 'opencode', sessionId: 'copy-session', cwd: '/repo', codexHome: null }
      },
      startup
    )
    expect(effective.command).toContain("'--standalone'")
    expect(effective.command).toContain("'--model' 'synthetic-model'")
    expect(effective.env).toMatchObject({
      OPENCODE_AUTH_CONTENT: 'synthetic-local-auth',
      HOME: '/host-home',
      OPENCODE_CONFIG_DIR: '/host-config'
    })
  })

  it('keeps the custom session store after the resumed process reports its id', async () => {
    const store = createTestStore()
    const worktreeId = 'repo-1::/repo'
    store.setState({
      activeWorkspaceExecutionHostId: 'local',
      activeRepoId: 'repo-1',
      activeWorktreeId: worktreeId,
      folderWorkspaces: [],
      projectGroups: [],
      projects: [{ id: 'repo-1', sourceRepoIds: ['repo-1'] }],
      repos: [{ id: 'repo-1', path: '/repo', executionHostId: 'local' }],
      settings: {
        agentDefaultArgs: { omp: '--model custom' },
        agentDefaultEnv: { omp: { OMP_PROFILE: 'custom' } }
      } as unknown as NonNullable<AppState['settings']>,
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId })]
      },
      worktreesByRepo: {
        'repo-1': [{ id: worktreeId, repoId: 'repo-1', path: '/repo', hostId: 'local' }]
      }
    } as unknown as Partial<AppState>)

    const args = {
      state: store.getState(),
      worktreeId,
      session: {
        agent: 'omp' as const,
        executionHostId: 'local' as const,
        sessionId: 'omp-session-1',
        filePath: '/custom/omp-sessions/project/session.jsonl',
        cwd: '/repo',
        codexHome: null
      }
    }
    expect(getExecutionHostIdForWorktree(args.state, worktreeId)).toBe('local')
    expect(resolveTerminalHostOwnership(args.state, worktreeId, 'spawn')).toEqual({
      kind: 'local-or-ssh',
      runtimeEnvironmentId: null
    })
    const selected = buildAiVaultResumeStartupForWorktree(args)
    expect(selected).toMatchObject({
      resume: {
        recipe: { source: 'current-inputs' },
        ompResumeFilePath: '/custom/omp-sessions/project/session.jsonl'
      }
    })
    const startup = await materializeAiVaultResumeForTest(args, selected)

    expect(startup).toMatchObject({
      command: "omp '--model' 'custom' '--resume' '/custom/omp-sessions/project/session.jsonl'",
      cwd: '/repo',
      env: { OMP_PROFILE: 'custom' },
      launchConfig: {
        agentCommand: "omp '--model' 'custom'",
        agentArgs: '--model custom',
        agentEnv: { OMP_PROFILE: 'custom' },
        ompResumeFilePath: '/custom/omp-sessions/project/session.jsonl'
      },
      providerSession: { key: 'session_id', id: 'omp-session-1' }
    })

    store.getState().registerAgentLaunchConfig('tab-1:leaf-1', startup.launchConfig!, {
      agentType: 'omp',
      launchToken: 'launch-1',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'omp',
        startup.providerSession!,
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId },
        { launchToken: 'launch-1' }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'resume', agentType: 'omp' },
        'OMP',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId },
        { providerSession: startup.providerSession, launchToken: 'launch-1' }
      )
    store.getState().captureAllSleepingAgentSessions('quit')

    const record = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']!
    const coldStartup = buildAgentResumeStartupPlan({
      agent: record.agent,
      providerSession: record.providerSession,
      cmdOverrides: {},
      agentArgs: record.launchConfig?.agentArgs,
      agentEnv: record.launchConfig?.agentEnv,
      agentCommand: record.launchConfig?.agentCommand,
      ompResumeFilePath: record.launchConfig?.ompResumeFilePath,
      platform: 'linux'
    })

    expect(record).toMatchObject({
      providerSession: { key: 'session_id', id: 'omp-session-1' },
      launchConfig: {
        agentEnv: { OMP_PROFILE: 'custom' },
        ompResumeFilePath: '/custom/omp-sessions/project/session.jsonl'
      },
      origin: 'quit'
    })
    expect(coldStartup).toMatchObject({
      launchCommand:
        "omp '--model' 'custom' '--resume' '/custom/omp-sessions/project/session.jsonl'",
      env: { OMP_PROFILE: 'custom' }
    })
  })
})
