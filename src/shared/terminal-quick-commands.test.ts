import { describe, expect, it } from 'vitest'
import {
  applyTerminalQuickCommandMutation,
  buildTerminalQuickCommandInput,
  normalizeTerminalQuickCommandText,
  normalizeTerminalQuickCommands,
  parseNormalizedTerminalQuickCommands,
  terminalQuickCommandMatchesRepo
} from './terminal-quick-commands'

describe('terminal quick commands', () => {
  it('preserves lists larger than forty commands across loading and protocol parsing', () => {
    const commands = Array.from({ length: 100 }, (_, index) => ({
      id: `command-${index}`,
      label: `Command ${index}`,
      action: 'terminal-command' as const,
      command: 'echo saved',
      appendEnter: true,
      scope: { type: 'repo' as const, repoId: `project-${index}` }
    }))

    expect(normalizeTerminalQuickCommands(commands)).toEqual(commands)
    expect(parseNormalizedTerminalQuickCommands(commands)).toEqual(commands)
  })

  it('normalizes agent prompt commands without storing generated shell text', () => {
    expect(
      normalizeTerminalQuickCommands([
        {
          id: 'agent-review',
          label: 'Review',
          action: 'agent-prompt',
          agent: 'codex',
          prompt: '  Review this diff\n',
          command: "codex 'old workaround'"
        },
        {
          id: 'unknown-agent',
          label: 'Unknown',
          action: 'agent-prompt',
          agent: 'not-real',
          prompt: 'Do work'
        },
        {
          id: 'post-start-agent',
          label: 'Aider',
          action: 'agent-prompt',
          agent: 'aider',
          prompt: 'Do work'
        }
      ])
    ).toEqual([
      {
        id: 'agent-review',
        label: 'Review',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: '  Review this diff',
        scope: { type: 'global' }
      }
    ])
  })

  it('keeps agent prompts whole while bounding shell commands', () => {
    const largePrompt = 'Review this diff.\n'.repeat(320)
    const overLimitPrompt = 'x'.repeat(6001)
    const overLimitCommand = 'y'.repeat(4001)

    expect(
      normalizeTerminalQuickCommands([
        {
          id: 'large-review',
          label: 'Review',
          action: 'agent-prompt',
          agent: 'codex',
          prompt: largePrompt
        },
        {
          id: 'over-limit-review',
          label: 'Review with cap',
          action: 'agent-prompt',
          agent: 'codex',
          prompt: overLimitPrompt
        },
        {
          id: 'over-limit-command',
          label: 'Run long command',
          command: overLimitCommand
        }
      ])
    ).toEqual([
      {
        id: 'large-review',
        label: 'Review',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: largePrompt.trimEnd(),
        scope: { type: 'global' }
      },
      {
        id: 'over-limit-review',
        label: 'Review with cap',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: overLimitPrompt,
        scope: { type: 'global' }
      },
      {
        id: 'over-limit-command',
        label: 'Run long command',
        action: 'terminal-command',
        command: 'y'.repeat(4000),
        appendEnter: true,
        scope: { type: 'global' }
      }
    ])
  })

  it('accepts only complete canonical command lists at protocol boundaries', () => {
    const canonical = normalizeTerminalQuickCommands([
      { id: 'status', label: 'Status', command: 'git status', appendEnter: true }
    ])

    expect(parseNormalizedTerminalQuickCommands(canonical)).toEqual(canonical)
    expect(parseNormalizedTerminalQuickCommands([{ ...canonical[0], command: 42 }])).toBeNull()
    expect(
      parseNormalizedTerminalQuickCommands([...canonical, ...canonical.slice(0, 1)])
    ).toBeNull()
  })

  it('round-trips the v1 canonical script payload without changing its trimEnd invariant', () => {
    const v1Payload = {
      id: 'script',
      label: 'Script',
      action: 'terminal-command',
      command: 'printf "%s\\n" \\\n  "one"\n\nif true; then\n  echo two\nfi',
      appendEnter: true,
      scope: { type: 'global' }
    }
    const saved = normalizeTerminalQuickCommands([
      { ...v1Payload, command: `${v1Payload.command}\n \t` }
    ])

    expect(saved).toEqual([v1Payload])
    expect(parseNormalizedTerminalQuickCommands(saved)).toEqual([v1Payload])
    expect(parseNormalizedTerminalQuickCommands([v1Payload])).toEqual(saved)
    expect(
      parseNormalizedTerminalQuickCommands([{ ...v1Payload, command: `${v1Payload.command}\n` }])
    ).toBeNull()
  })

  it('applies targeted mutations without replacing unrelated commands', () => {
    const [first, second] = normalizeTerminalQuickCommands([
      { id: 'first', label: 'First', command: 'echo first', appendEnter: true },
      { id: 'second', label: 'Second', command: 'echo second', appendEnter: true }
    ])
    const edited = { ...first!, label: 'Edited' }

    expect(
      applyTerminalQuickCommandMutation([first!, second!], {
        type: 'upsert',
        command: edited
      })
    ).toEqual([edited, second])
    expect(
      applyTerminalQuickCommandMutation([first!, second!], { type: 'delete', id: first!.id })
    ).toEqual([second])
  })

  it('matches global commands everywhere and repo commands only in their repo', () => {
    expect(
      terminalQuickCommandMatchesRepo(
        {
          id: 'global',
          label: 'Global',
          command: 'date',
          appendEnter: true,
          scope: { type: 'global' }
        },
        null
      )
    ).toBe(true)
    expect(
      terminalQuickCommandMatchesRepo(
        {
          id: 'repo',
          label: 'Repo',
          command: 'pnpm dev',
          appendEnter: true,
          scope: { type: 'repo', repoId: 'repo-1' }
        },
        'repo-1'
      )
    ).toBe(true)
    expect(
      terminalQuickCommandMatchesRepo(
        {
          id: 'repo',
          label: 'Repo',
          command: 'pnpm dev',
          appendEnter: true,
          scope: { type: 'repo', repoId: 'repo-1' }
        },
        'repo-2'
      )
    ).toBe(false)
  })
})

describe('normalizeTerminalQuickCommandText', () => {
  it('normalizes CRLF and CR without rewriting shell syntax or whitespace', () => {
    const command = '  printf "%s\\n" \\\n  "one"\n\nif true; then\n  echo two\nfi\n\n'
    for (const newline of ['\n', '\r\n', '\r']) {
      expect(normalizeTerminalQuickCommandText(command.replace(/\n/g, newline))).toBe(command)
    }
  })
})

describe('multiline quick-command submission', () => {
  const command = {
    id: 'script',
    label: 'Script',
    command: 'if true; then\r\n  printf "%s\\n" \\\r\n    "block"\r\nfi\r\n\r\n',
    appendEnter: true
  }

  it('keeps the whole body and trailing newlines inside a paste frame', () => {
    expect(buildTerminalQuickCommandInput(command, { bracketedPasteSafe: true })).toBe(
      '\x1b[200~if true; then\r  printf "%s\\n" \\\r    "block"\rfi\r\r\x1b[201~\r'
    )
  })

  it('inserts a multiline command without sending Enter after its paste frame', () => {
    expect(
      buildTerminalQuickCommandInput(
        { ...command, appendEnter: false },
        { bracketedPasteSafe: true }
      )
    ).toBe('\x1b[200~if true; then\r  printf "%s\\n" \\\r    "block"\rfi\r\r\x1b[201~')
  })

  it('never emits paste escape sequences to a shell without bracketed paste', () => {
    expect(
      buildTerminalQuickCommandInput(
        { ...command, command: 'echo one\r\necho two' },
        { bracketedPasteSafe: false }
      )
    ).toBe('echo one\recho two\r')
  })
})
