import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import { describe, expect, it, vi } from 'vitest'
import {
  normalizeTerminalQuickCommandText,
  normalizeTerminalQuickCommands,
  isTerminalAgentQuickCommand
} from './terminal-quick-commands'
import { stageStartupCommand, discardStagedStartupCommand } from './startup-command-staging'
import { buildStartupCommandSubmission } from './startup-command-submission'
import { wrapTerminalBracketedPasteText } from './terminal-bracketed-paste-text'

const script = `printf '%s\\n' \\
  'CONTINUATION_OK'
if [ 2 -gt 1 ]; then
  printf '%s\\n' 'BLOCK_OK'
fi
cat <<'END_BODY'
HEREDOC_OK
END_BODY
printf 'EXECUTION_%s\\n' END
cat <<'FINAL_BODY'
HEREDOC_FINAL_OK
FINAL_BODY

`
const shells =
  process.platform === 'win32'
    ? []
    : [
        {
          path: '/bin/bash',
          args: ['--noprofile', '--norc', '-i'],
          bracketedPaste: process.platform !== 'darwin'
        },
        {
          path: '/opt/homebrew/bin/bash',
          args: ['--noprofile', '--norc', '-i'],
          bracketedPaste: true
        },
        { path: '/bin/zsh', args: ['-f', '-i'], bracketedPaste: true }
      ].filter((shell) => existsSync(shell.path))

async function exercise(
  shell: (typeof shells)[number],
  mode: 'startup' | 'run',
  command = script,
  readsInput = false
) {
  const savedCommand = normalizeTerminalQuickCommands([
    { id: 'script', label: 'Script', command, appendEnter: mode === 'run' }
  ])[0]
  if (!savedCommand || isTerminalAgentQuickCommand(savedCommand)) {
    throw new Error('Expected a saved terminal script')
  }
  const proc = pty.spawn(shell.path, shell.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    // Empty HISTFILE keeps bash and zsh from saving test commands to the developer's history on SIGHUP.
    env: { ...process.env, HISTFILE: '', PS1: 'QUICK_READY> ', PROMPT: 'QUICK_READY> ' }
  })
  let output = ''
  const listener = proc.onData((data) => {
    output += data
  })
  const waitFor = (value: string) =>
    vi.waitFor(() => expect(output).toContain(value), { timeout: 5000, interval: 20 })
  let staged
  try {
    await waitFor('QUICK_READY> ')
    if (mode === 'startup') {
      staged = stageStartupCommand({
        command: normalizeTerminalQuickCommandText(savedCommand.command.replace(/\n/g, '\r\n')),
        shellPath: shell.path
      })
      expect(staged.delivery).toBe('staged')
      proc.write(
        buildStartupCommandSubmission(staged.command, {
          bracketedPasteSafe: false
        })
      )
    } else {
      await waitFor('\x1b[?2004h')
      // Same bytes the pane paste path sends: one frame, then Enter in a separate write.
      proc.write(wrapTerminalBracketedPasteText(savedCommand.command))
      // The line editor echoes the pasted format string; the run would print EXECUTION_END.
      await waitFor('EXECUTION_%s')
      expect(output).not.toContain('EXECUTION_END')
      proc.write('\r')
    }
    if (readsInput) {
      await waitFor('INPUT_READY\r\n')
      proc.write('reader-value\r')
    }
    await waitFor('EXECUTION_END')
    if (readsInput) {
      expect(output).toContain('ANSWER_reader-value\r\n')
      expect(output).toContain('COMMAND_MUST_RUN\r\n')
    } else {
      expect(output).toContain('CONTINUATION_OK\r\n')
      expect(output).toContain('BLOCK_OK\r\n')
      expect(output).toContain('HEREDOC_OK\r\n')
      await waitFor('HEREDOC_FINAL_OK\r\n')
    }
  } finally {
    listener.dispose()
    proc.kill()
    discardStagedStartupCommand(staged)
  }
}

// Windows has no POSIX shell to drive; an empty inventory must skip rather than fail collection.
describe.skipIf(shells.length === 0)('multiline quick-command shells', () => {
  describe.each(shells)('saved shell scripts in $path', (shell) => {
    it('executes continuations, blocks and heredocs through new-tab staging', async () => {
      await exercise(shell, 'startup')
    })
  })

  describe.each(shells.filter((shell) => shell.bracketedPaste))(
    'saved script submission in $path',
    (shell) => {
      it('holds a bracketed script until Enter, then runs continuations, blocks and heredocs', async () => {
        await exercise(shell, 'run')
      })

      it.each(['startup', 'run'] as const)(
        '%s keeps later script lines out of a foreground command reading stdin',
        async (mode) => {
          await exercise(
            shell,
            mode,
            `printf 'INPUT_%s\\n' READY
  read -r answer
  printf 'ANSWER_%s\\n' "$answer"
  printf 'COMMAND_%s\\n' MUST_RUN
  printf 'EXECUTION_%s\\n' END`,
            true
          )
        }
      )
    }
  )
})
