import type {
  TerminalCommandQuickCommand,
  TerminalQuickCommand
} from '../../../../shared/terminal-quick-command-types'
import {
  buildTerminalQuickCommandInput,
  isTerminalAgentQuickCommand,
  normalizeTerminalQuickCommandText
} from '../../../../shared/terminal-quick-commands'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { encodeWindowsInputRecordPasteText } from './terminal-bracketed-paste'
import type { TerminalPasteTextOptions } from './terminal-paste-model'
import type { PtyTransport } from './pty-transport-types'

type QuickCommandPane = {
  leafId: string
  terminal: {
    focus: () => void
    modes: { bracketedPasteMode: boolean }
  }
}

type QuickCommandTransport = Pick<PtyTransport, 'sendInput'>

export function sendTerminalQuickCommandToPane({
  command,
  pane,
  tabId,
  transport,
  multilinePasteOptions,
  onError
}: {
  command: TerminalQuickCommand
  pane: QuickCommandPane
  tabId: string
  transport: QuickCommandTransport | null | undefined
  /** Same framing as a user paste into this pane: ConPTY can drop DECSET 2004, and input-record agents need modified Enter. */
  multilinePasteOptions: TerminalPasteTextOptions | undefined
  onError: (message: string) => void
}): boolean {
  if (isTerminalAgentQuickCommand(command)) {
    return false
  }
  if (!transport) {
    return false
  }

  const input = buildQuickCommandPaneInput(command, pane, multilinePasteOptions)
  if (input === null) {
    onError(
      'This shell cannot safely receive a multiline command here. Use a script file or a shell with bracketed paste.'
    )
    return false
  }

  const sent = transport.sendInput(input, 'driving')
  if (sent) {
    recordTerminalUserInputForLeaf(tabId, pane.leafId)
    pane.terminal.focus()
  }
  return sent
}

function buildQuickCommandPaneInput(
  command: TerminalCommandQuickCommand,
  pane: QuickCommandPane,
  options: TerminalPasteTextOptions | undefined
): string | null {
  if (!/[\r\n]/.test(command.command)) {
    return buildTerminalQuickCommandInput(command)
  }
  if (options?.windowsInputRecordNewline) {
    const text = encodeWindowsInputRecordPasteText(
      normalizeTerminalQuickCommandText(command.command),
      options.windowsInputRecordNewline
    )
    return command.appendEnter ? `${text}\r` : text
  }
  const bracketedPasteSafe =
    pane.terminal.modes.bracketedPasteMode || options?.forceBracketedPasteForMultiline === true
  // Insert must not run anything, and unframed newlines submit each line; Run may type them raw.
  if (!command.appendEnter && !bracketedPasteSafe) {
    return null
  }
  return buildTerminalQuickCommandInput(command, { bracketedPasteSafe })
}
