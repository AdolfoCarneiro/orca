import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPasteTextOptions } from './terminal-paste-model'

const mocks = vi.hoisted(() => ({
  recordTerminalUserInputForLeaf: vi.fn()
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'

const REFUSAL =
  'This shell cannot safely receive a multiline command here. Use a script file or a shell with bracketed paste.'

function setup({
  bracketedPasteMode = true,
  multilinePasteOptions,
  pasted = true,
  accepted = true
}: {
  bracketedPasteMode?: boolean
  multilinePasteOptions?: TerminalPasteTextOptions
  pasted?: boolean
  accepted?: boolean
} = {}) {
  const writes: string[] = []
  const sendInput = vi.fn((data: string) => {
    writes.push(data)
    return accepted
  })
  const pasteText = vi.fn(
    async (text: string, _options: unknown, submitInput: string | undefined) => {
      writes.push(`paste:${text}`)
      if (pasted && submitInput) {
        writes.push(submitInput)
      }
      return pasted
    }
  )
  const onError = vi.fn()
  const pane = { leafId: 'leaf-1', terminal: { focus: vi.fn(), modes: { bracketedPasteMode } } }
  const send = (command: string, appendEnter: boolean) =>
    sendTerminalQuickCommandToPane({
      command: { id: 'cmd', label: 'Cmd', command, appendEnter },
      pane,
      tabId: 'tab-1',
      transport: { sendInput },
      multilinePasteOptions,
      pasteText,
      onError
    })
  return { writes, pasteText, onError, pane, send }
}

describe('sendTerminalQuickCommandToPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes a single-line command to the PTY transport and refocuses the terminal', async () => {
    const { writes, pasteText, pane, send } = setup()

    expect(await send('git status', true)).toBe(true)
    expect(writes).toEqual(['git status\r'])
    expect(pasteText).not.toHaveBeenCalled()
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
  })

  it('does not focus the terminal when no connected transport accepts input', async () => {
    const { pane, send } = setup({ accepted: false })

    expect(await send('npm test', false)).toBe(false)
    expect(pane.terminal.focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })

  it('pastes a multiline Run through the pane paste path with Enter as its submit input', async () => {
    const options = { forceBracketedPasteForMultiline: true }
    const { writes, pasteText, pane, send } = setup({ multilinePasteOptions: options })

    expect(await send('cd packages\r\nbun run build\rcd ..', true)).toBe(true)
    expect(pasteText).toHaveBeenCalledWith('cd packages\nbun run build\ncd ..', options, '\r')
    expect(writes).toEqual(['paste:cd packages\nbun run build\ncd ..', '\r'])
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })

  it('pastes a multiline Insert into a bracketed pane without submitting', async () => {
    const { writes, send } = setup()

    expect(await send('echo one\necho two', false)).toBe(true)
    expect(writes).toEqual(['paste:echo one\necho two'])
  })

  it('pastes a multiline Run into a pane without bracketed paste so its lines are typed', async () => {
    const { writes, send } = setup({ bracketedPasteMode: false })

    expect(await send('cd app\nnpm test', true)).toBe(true)
    expect(writes).toEqual(['paste:cd app\nnpm test', '\r'])
  })

  it.each(['\n', '\r\n', '\r'])(
    'refuses a multiline Insert before sending bytes without bracketed paste (%j)',
    async (newline) => {
      const { writes, onError, pane, send } = setup({ bracketedPasteMode: false })

      expect(await send(['echo one', 'echo two'].join(newline), false)).toBe(false)
      expect(writes).toEqual([])
      expect(onError).toHaveBeenCalledWith(REFUSAL)
      expect(pane.terminal.focus).not.toHaveBeenCalled()
    }
  )

  it.each<TerminalPasteTextOptions>([
    { forceBracketedPasteForMultiline: true },
    { windowsInputRecordNewline: 'alt-enter' }
  ])('inserts multiline commands where the pane paste path frames them (%j)', async (options) => {
    const { writes, send } = setup({ bracketedPasteMode: false, multilinePasteOptions: options })

    expect(await send('first\nsecond', false)).toBe(true)
    expect(writes).toEqual(['paste:first\nsecond'])
  })

  it('does not submit or focus when the pane paste path rejects the script', async () => {
    const { writes, pane, send } = setup({ pasted: false })

    expect(await send('echo one\necho two', true)).toBe(false)
    expect(writes).toEqual(['paste:echo one\necho two'])
    expect(pane.terminal.focus).not.toHaveBeenCalled()
  })

  it('does not write agent prompt quick commands into the current pane', async () => {
    const sendInput = vi.fn(() => true)
    const pasteText = vi.fn()
    const focus = vi.fn()

    const sent = await sendTerminalQuickCommandToPane({
      command: {
        id: 'agent',
        label: 'Agent',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'Review this'
      },
      pane: { leafId: 'leaf-1', terminal: { focus, modes: { bracketedPasteMode: true } } },
      tabId: 'tab-1',
      transport: { sendInput },
      multilinePasteOptions: undefined,
      pasteText,
      onError: vi.fn()
    })

    expect(sent).toBe(false)
    expect(sendInput).not.toHaveBeenCalled()
    expect(pasteText).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })
})
