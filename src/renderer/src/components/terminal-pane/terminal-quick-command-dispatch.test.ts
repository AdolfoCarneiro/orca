import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  recordTerminalUserInputForLeaf: vi.fn()
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'

function createPane() {
  return {
    leafId: 'leaf-1',
    terminal: {
      focus: vi.fn(),
      modes: { bracketedPasteMode: true }
    }
  }
}

describe('sendTerminalQuickCommandToPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes the formatted command to the PTY transport and refocuses the terminal', () => {
    const sendInput = vi.fn(() => true)
    const pane = createPane()

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'status',
        label: 'Status',
        command: 'git status',
        appendEnter: true
      },
      pane,
      tabId: 'tab-1',
      transport: { sendInput },
      multilinePasteOptions: undefined,
      onError: vi.fn()
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('git status\r', 'driving')
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
  })

  it('does not focus the terminal when no connected transport accepts input', () => {
    const sendInput = vi.fn(() => false)
    const pane = createPane()

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'draft',
        label: 'Draft',
        command: 'npm test',
        appendEnter: false
      },
      pane,
      tabId: 'tab-1',
      transport: { sendInput },
      multilinePasteOptions: undefined,
      onError: vi.fn()
    })

    expect(sent).toBe(false)
    expect(sendInput).toHaveBeenCalledWith('npm test', 'driving')
    expect(pane.terminal.focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })

  it('pastes multiline commands as one shell input before submitting', () => {
    const sendInput = vi.fn(() => true)
    const pane = createPane()
    const commandText = 'cd packages\nbun run build\ncd ..'

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'build',
        label: 'Build',
        command: commandText,
        appendEnter: true
      },
      pane,
      tabId: 'tab-1',
      transport: { sendInput },
      multilinePasteOptions: undefined,
      onError: vi.fn()
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith(
      '\x1b[200~cd packages\rbun run build\rcd ..\x1b[201~\r',
      'driving'
    )
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })

  it('pastes multiline insert-only commands without submitting', () => {
    const sendInput = vi.fn(() => true)
    const pane = createPane()
    const commandText = 'echo one\necho two'

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'insert',
        label: 'Insert',
        command: commandText,
        appendEnter: false
      },
      pane,
      tabId: 'tab-1',
      transport: { sendInput },
      multilinePasteOptions: undefined,
      onError: vi.fn()
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('\x1b[200~echo one\recho two\x1b[201~', 'driving')
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })

  it.each(['\n', '\r\n', '\r'])(
    'refuses multiline Insert before sending bytes without bracketed paste (%j)',
    (newline) => {
      const sendInput = vi.fn(() => true)
      const onError = vi.fn()
      const pane = createPane()
      pane.terminal.modes.bracketedPasteMode = false
      expect(
        sendTerminalQuickCommandToPane({
          command: {
            id: 'script',
            label: 'Script',
            command: ['echo one', 'echo two'].join(newline),
            appendEnter: false
          },
          pane,
          tabId: 'tab-1',
          transport: { sendInput },
          multilinePasteOptions: undefined,
          onError
        })
      ).toBe(false)
      expect(sendInput).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith(
        'This shell cannot safely receive a multiline command here. Use a script file or a shell with bracketed paste.'
      )
      expect(pane.terminal.focus).not.toHaveBeenCalled()
    }
  )

  it('types multiline Run commands line by line without bracketed paste', () => {
    const sendInput = vi.fn(() => true)
    const pane = createPane()
    pane.terminal.modes.bracketedPasteMode = false

    const sent = sendTerminalQuickCommandToPane({
      command: { id: 'build', label: 'Build', command: 'cd app\r\nnpm test', appendEnter: true },
      pane,
      tabId: 'tab-1',
      transport: { sendInput },
      multilinePasteOptions: undefined,
      onError: vi.fn()
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('cd app\rnpm test\r', 'driving')
  })

  it('frames multiline commands on Windows clients whose ConPTY dropped the bracketed paste mode', () => {
    const sendInput = vi.fn(() => true)
    const pane = createPane()
    pane.terminal.modes.bracketedPasteMode = false

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'build',
        label: 'Build',
        command: 'npm install\nnpm test',
        appendEnter: true
      },
      pane,
      tabId: 'tab-1',
      transport: { sendInput },
      multilinePasteOptions: { forceBracketedPasteForMultiline: true },
      onError: vi.fn()
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('\x1b[200~npm install\rnpm test\x1b[201~\r', 'driving')
  })

  it('inserts multiline commands into Windows input-record agents with modified Enter', () => {
    const sendInput = vi.fn(() => true)

    const sent = sendTerminalQuickCommandToPane({
      command: { id: 'insert', label: 'Insert', command: 'first\nsecond', appendEnter: false },
      pane: createPane(),
      tabId: 'tab-1',
      transport: { sendInput },
      multilinePasteOptions: { windowsInputRecordNewline: 'alt-enter' },
      onError: vi.fn()
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('first\x1b\rsecond', 'driving')
  })

  it('does not write agent prompt quick commands into the current pane', () => {
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'agent',
        label: 'Agent',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'Review this'
      },
      pane: {
        leafId: 'leaf-1',
        terminal: { focus, modes: { bracketedPasteMode: true } }
      },
      tabId: 'tab-1',
      transport: { sendInput },
      multilinePasteOptions: undefined,
      onError: vi.fn()
    })

    expect(sent).toBe(false)
    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })
})
