import { describe, expect, it } from 'vitest'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

function launch(args: Partial<Parameters<typeof resolveAgentLaunchCommand>[0]>) {
  const result = resolveAgentLaunchCommand({
    agent: 'claude',
    cmdOverrides: {},
    platform: 'linux',
    shell: 'posix',
    ...args
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result
}

describe('one copy of each chat-picked flag', () => {
  it.each(['-c model=o3', '--config model=o3', '-c=model=o3', '-cmodel=o3', '--config=model=o3'])(
    'yields the picked Codex model and its effort to configured %s',
    (agentArgs) => {
      const result = launch({
        agent: 'codex',
        sessionOptions: { model: 'gpt-5.5', effort: 'high' },
        agentArgs
      })
      const expectedArgs = agentArgs
        .split(' ')
        .map((token) => `'${token}'`)
        .join(' ')
      expect(result.command).toBe(`codex ${expectedArgs}`)
      expect(result.appliedSessionOptions).toEqual({})
    }
  )

  it('treats spaced Codex config model and effort as raw pins or removes them when overridden', () => {
    const agentArgs = '-c " model = o3" -c " model_reasoning_effort = low" -c model_verbosity=low'
    const inputs = {
      agent: 'codex' as const,
      agentArgs,
      sessionOptions: { model: 'gpt-5.5', effort: 'high' }
    }
    expect(launch(inputs).appliedSessionOptions).toEqual({})
    const saved = launch({ ...inputs, sessionOptionsOverrideAgentArgs: true })
    expect(saved.appliedSessionOptions).toEqual(inputs.sessionOptions)
    expect(saved.resumeLaunch).toEqual({
      agentCommand: "codex '-c' 'model_verbosity=low'",
      agentArgs: "'-c' 'model_verbosity=low'"
    })
  })

  it.each([
    ['claude', 'opus', '--model=haiku', "claude '--model=haiku'"],
    ['codex', 'gpt-5.5', '-mo3', "codex '-mo3'"]
  ] as const)(
    'sends one model flag for %s with a configured %s',
    (agent, model, agentArgs, command) => {
      const result = launch({ agent, sessionOptions: { model }, agentArgs })
      expect(result.command).toBe(command)
      expect(result.appliedSessionOptions).toEqual({})
    }
  )

  it('sends one --effort for Claude with a configured --effort', () => {
    const result = launch({
      sessionOptions: { model: 'opus', effort: 'xhigh' },
      agentArgs: '--effort low'
    })
    expect(result.command).toBe("claude '--model' 'opus' '--effort' 'low'")
    expect(result.appliedSessionOptions).toEqual({ model: 'opus' })
  })

  it('keeps the catalog default for options the configured args do not set', () => {
    const result = launch({ sessionOptions: { model: 'opus' }, agentArgs: '--add-dir x' })
    expect(result.command).toBe("claude '--model' 'opus' '--effort' 'high' '--add-dir' 'x'")
  })

  it('preserves picks when configured arguments contain flags after --', () => {
    const result = launch({
      agentArgs: '-- --model haiku',
      sessionOptions: { model: 'opus', effort: 'high' }
    })
    expect(result.command).toBe("claude '--model' 'opus' '--effort' 'high' '--' '--model' 'haiku'")
    expect(result.appliedSessionOptions).toEqual({ model: 'opus', effort: 'high' })
  })

  it('checks configured args without parsing an unparseable command override', () => {
    const result = launch({
      agent: 'codex',
      cmdOverrides: { codex: "codex -c 'x" },
      sessionOptions: { model: 'gpt-5.5' },
      agentArgs: '-m o3'
    })
    expect(result.command).toBe("codex -c 'x '-m' 'o3'")
    expect(result.command).not.toContain('gpt-5.5')
  })

  it('sends the picked Codex model when the configured args set only the effort', () => {
    const result = launch({
      agent: 'codex',
      sessionOptions: { model: 'gpt-5.5', effort: 'high' },
      agentArgs: '-c model_reasoning_effort=low'
    })
    expect(result.command).toBe("codex '-m' 'gpt-5.5' '-c' 'model_reasoning_effort=low'")
    expect(result.appliedSessionOptions).toEqual({ model: 'gpt-5.5' })
  })
})

describe('a saved permission mode on terminals', () => {
  it('yields to a permission flag the caller keeps', () => {
    const result = launch({
      agent: 'claude',
      agentArgs: '--dangerously-skip-permissions',
      sessionOptions: { permissionMode: 'ask' }
    })
    expect(result.command).toBe("claude '--dangerously-skip-permissions'")
    expect(result.appliedSessionOptions).toEqual({})
  })
})

describe.each(['posix', 'powershell', 'cmd'] as const)('command permission on %s', (shell) => {
  it.each(['--yolo', '-y'])('keeps Kimi %s without adding the Full access recipe', (permission) => {
    for (const sessionOptions of [undefined, { permissionMode: 'full-access' }]) {
      const plan = buildAgentStartupPlan({
        ...resolveAgentStartupPlanInputs({
          agent: 'kimi',
          settings: {
            agentPermissionDefault: 'full-access',
            agentCmdOverrides: { kimi: `kimi ${permission}` },
            agentDefaultArgs: { kimi: '' }
          },
          platform: shell === 'posix' ? 'linux' : 'win32',
          isRemote: false,
          shell,
          sessionOptions
        }),
        prompt: '',
        allowEmptyPromptLaunch: true
      })
      expect(plan).not.toBeNull()
      expect(tokenizeStartupCommand(plan?.launchCommand ?? '', shell)).toMatchObject({
        ok: true,
        tokens: ['kimi', permission]
      })
    }
  })

  it('honors a Claude command permission while retaining its other arguments', () => {
    const plan = buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings: {
          agentPermissionDefault: 'full-access',
          agentCmdOverrides: { claude: 'claude --permission-mode plan' },
          agentDefaultArgs: { claude: '--model opus' }
        },
        platform: shell === 'posix' ? 'linux' : 'win32',
        isRemote: false,
        shell
      }),
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    expect(tokenizeStartupCommand(plan?.launchCommand ?? '', shell)).toMatchObject({
      ok: true,
      tokens: ['claude', '--permission-mode', 'plan', '--model', 'opus']
    })
  })
})
