import { partialRuntimeStore } from './runtime-store-partial-fixture'
import { isAgentResumeNotDispatchedResponse } from '../../shared/agent-terminal-resume-outcome'
import { mapRuntimeError } from './rpc/errors'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectAgentCommandsOnHost } from '../preflight/agent-detection'
import { resolveAgentTerminalCreateOptions } from './runtime-agent-terminal-startup'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../wsl'

vi.mock('../preflight/agent-detection', () => ({
  detectAgentCommandsOnHost: vi.fn(async () => new Set(['qoder']))
}))

const workspace = { id: 'w', path: '/repo', connectionId: null, repo: null, folderWorkspace: null }
const host = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: for a workspace with no repo or folder, the planner reads only getSettings.
  store: { getSettings: () => ({ terminalWindowsShell: 'cmd.exe' }) } as never,
  hostIdentity: 'host-1',
  toSessionOptions: () => undefined
}
const original = process.platform
const setPlatform = (value: string) =>
  Object.defineProperty(process, 'platform', { configurable: true, value })
beforeEach(() => setPlatform('win32'))
afterEach(() => {
  setPlatform(original)
  _resetWslCachesForTests()
})

// The host planner's inputs. Relied on by C2, whose pane spawns run this plan.
describe('host agent planner', () => {
  it("quotes for the fact's shell and hands that same fact to the spawn", async () => {
    const launch = await resolveAgentTerminalCreateOptions(
      workspace,
      { startupAgent: 'claude', agentArgs: '--model opus' },
      host
    )
    expect(launch.command).toBe('claude "--model" "opus"')
    expect(launch.launchRuntime).toEqual({
      platform: 'win32',
      pty: { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
    })
  })

  // As on main: a disabled agent is refused as disabled, before its runtime is looked at.
  it('refuses a disabled agent before a runtime that needs repair', async () => {
    _setWslCachesForTests({ available: true, distros: ['Debian'] })
    const repo = { id: 'r', path: 'C:\\r' }
    const preference = { kind: 'wsl', distro: 'Ubuntu' }
    const store = {
      getSettings: () => ({ disabledTuiAgents: ['claude'] }),
      getProjects: () => [
        { id: 'p', sourceRepoIds: ['r'], localWindowsRuntimePreference: preference }
      ],
      getRepo: () => repo
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the planner reads only these members and fields.
    const scope = { ...workspace, id: 'r', path: repo.path, repo } as never
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    const planHost = { ...host, store: store as never }
    const plan = resolveAgentTerminalCreateOptions(scope, { startupAgent: 'claude' }, planHost)
    await expect(plan).rejects.toThrow('Agent claude is disabled')
  })

  it("rewrites Qoder once, probing where the fact's PTY runs (C2 skips the window copy)", async () => {
    vi.mocked(detectAgentCommandsOnHost).mockClear()
    const launch = await resolveAgentTerminalCreateOptions(
      workspace,
      {
        startupAgent: 'qoder',
        agentArgs: null,
        launchRuntime: {
          platform: 'linux',
          pty: { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
        }
      },
      host
    )
    expect(launch.command).toBe('qoder')
    expect(detectAgentCommandsOnHost).toHaveBeenCalledTimes(1)
    expect(vi.mocked(detectAgentCommandsOnHost).mock.calls[0]?.[1]).toMatchObject({
      context: { wslDistro: 'Ubuntu' }
    })
  })

  // A `\\wsl$` cwd runs in WSL whatever the project says, so a WSL shell is what this agent gets.
  it('applies --shell wsl.exe for an agent in a WSL-share repo set to Windows host', async () => {
    const repo = { id: 'r', path: '\\\\wsl$\\Ubuntu\\r' }
    const preference = { kind: 'windows-host' }
    const store = {
      getSettings: () => ({ terminalWindowsShell: 'cmd.exe' }),
      getProjects: () => [
        { id: 'p', sourceRepoIds: ['r'], localWindowsRuntimePreference: preference }
      ],
      getRepo: () => repo
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the planner reads only these members and fields.
    const share = { ...workspace, id: 'r', path: repo.path, repo } as never
    const opts = { startupAgent: 'claude', shellOverride: 'wsl.exe' } as const
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    const planHost = { ...host, store: store as never }
    const launch = await resolveAgentTerminalCreateOptions(share, opts, planHost)
    expect(launch.launchRuntime?.pty.shellOverride).toBe('wsl.exe')
  })
})

describe('host-planned resumes', () => {
  it.each([
    { settingsShell: 'cmd.exe', shellOverride: undefined, expected: `codex "resume" "session's"` },
    {
      settingsShell: 'powershell.exe',
      shellOverride: 'cmd.exe',
      expected: `codex "resume" "session's"`
    },
    {
      settingsShell: 'powershell.exe',
      shellOverride: undefined,
      expected: "codex 'resume' 'session''s'"
    }
  ])(
    'quotes saved identity for $settingsShell with override $shellOverride',
    async ({ settingsShell, shellOverride, expected }) => {
      const launch = await resolveAgentTerminalCreateOptions(
        workspace,
        {
          startupAgent: 'codex',
          resume: {
            recipe: { source: 'saved' },
            providerSession: { key: 'session_id', id: "session's" }
          },
          shellOverride
        },
        {
          ...host,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this folder workspace reads only getSettings.
          store: { getSettings: () => ({ terminalWindowsShell: settingsShell }) } as never
        }
      )
      expect(launch.command).toBe(expected)
      expect(launch.resumeProviderSession).toEqual({ key: 'session_id', id: "session's" })
      expect(launch.startupCommandDelivery).toBe('shell-ready')
    }
  )

  it('quotes a raw saved identity for the WSL runtime selected by the host', async () => {
    const launch = await resolveAgentTerminalCreateOptions(
      workspace,
      {
        startupAgent: 'codex',
        resume: { recipe: { source: 'saved' } },
        resumeProviderSession: { key: 'session_id', id: "session's" },
        launchRuntime: {
          platform: 'linux',
          pty: { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
        }
      },
      host
    )
    expect(launch.command).toBe(`codex 'resume' 'session'"'"'s'`)
    expect(launch.launchRuntime?.platform).toBe('linux')
    expect(launch.startupCommandDelivery).toBe('shell-ready')
  })

  it('does not let selected Settings override an explicit home deletion', async () => {
    const launch = await resolveAgentTerminalCreateOptions(
      workspace,
      {
        startupAgent: 'codex',
        resumeProviderSession: { key: 'session_id', id: 'codex-session' },
        resume: { recipe: { source: 'saved' }, codexHome: null },
        envToDelete: ['EXPLICIT_DELETE']
      },
      host
    )
    expect(launch.envToDelete).toEqual(['EXPLICIT_DELETE', 'CODEX_HOME', 'ORCA_CODEX_HOME'])
  })
})

it('keeps typed and ordinary C1 refusals on the existing error contract', async () => {
  for (const typed of [true, false]) {
    const result = await resolveAgentTerminalCreateOptions(
      workspace,
      {
        startupAgent: 'claude',
        agentArgs: '"',
        ...(typed
          ? {
              resume: { recipe: { source: 'current-inputs' as const, settings: {} } },
              resumeProviderSession: { key: 'session_id' as const, id: 'session' }
            }
          : {})
      },
      host
    ).then(
      () => {
        throw new Error('Expected planning refusal')
      },
      (error: unknown) => error
    )
    const response = mapRuntimeError('request', { runtimeId: 'host' }, result)
    expect(response.error.code).toBe('runtime_error')
    expect(response.error.message).toBe(
      typed
        ? 'Could not build resume command for claude.'
        : 'Could not build launch command for claude.'
    )
    expect(isAgentResumeNotDispatchedResponse(response)).toBe(typed)
    if (!typed) {
      expect(response.error).not.toHaveProperty('data')
    }
  }
})

it('keeps host defaults, saved absence and literal saved values distinct at C1', async () => {
  const store = partialRuntimeStore({
    getSettings: () => ({
      agentCmdOverrides: { claude: 'host-claude' },
      agentDefaultArgs: { claude: '--model host-model' },
      agentDefaultEnv: { claude: { SETTINGS: 'host' } }
    })
  })
  const resolve = (resume: Parameters<typeof resolveAgentTerminalCreateOptions>[1]['resume']) =>
    resolveAgentTerminalCreateOptions(
      workspace,
      {
        startupAgent: 'claude',
        resume,
        resumeProviderSession: { key: 'session_id', id: 'saved', cwd: '/original' },
        launchRuntime: { platform: 'linux', pty: {} }
      },
      { ...host, store }
    )
  const defaults = await resolve({ recipe: { source: 'host-defaults' } })
  const absent = await resolve({ recipe: { source: 'saved' } })
  const literal = await resolve({
    recipe: {
      source: 'saved',
      launchConfig: {
        agentCommand: 'recorded-claude',
        agentArgs: '--model recorded',
        agentEnv: { SETTINGS: 'recorded' }
      }
    }
  })
  expect(defaults.command).toContain('host-model')
  expect(absent.launchConfig?.agentArgs).toBe('')
  expect(absent.env).toEqual({})
  expect(absent.command).toContain('/original')
  expect(
    (await resolve({ recipe: { source: 'saved' }, resumeInLaunchCwd: true })).command
  ).not.toContain('/original')
  expect(literal.command).toContain('recorded-claude')
  expect(literal.launchConfig?.agentArgs).toBe('--model recorded')
  expect(literal.env).toEqual({ SETTINGS: 'recorded' })
})

it('normalizes an OMP transcript for the actual host runtime before building its command', async () => {
  const launch = await resolveAgentTerminalCreateOptions(
    workspace,
    {
      startupAgent: 'omp',
      resume: {
        recipe: { source: 'saved' },
        ompResumeFilePath: String.raw`\\wsl$\Ubuntu\home\u\custom\saved.jsonl`
      },
      resumeProviderSession: { key: 'session_id', id: 'saved' },
      launchRuntime: {
        platform: 'linux',
        pty: { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
      }
    },
    host
  )
  expect(launch.command).toContain('/home/u/custom/saved.jsonl')
  expect(launch.command).not.toContain('wsl$')
  expect(launch.launchConfig?.ompResumeFilePath).toBe('/home/u/custom/saved.jsonl')
})
