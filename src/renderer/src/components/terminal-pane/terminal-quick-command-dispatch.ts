import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import {
  buildTerminalQuickCommandInput,
  isTerminalAgentQuickCommand,
  normalizeTerminalQuickCommandText
} from '../../../../shared/terminal-quick-commands'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
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

export async function sendTerminalQuickCommandToPane({
  command,
  pane,
  tabId,
  transport,
  multilinePasteOptions,
  pasteText,
  onError
}: {
  command: TerminalQuickCommand
  pane: QuickCommandPane
  tabId: string
  transport: QuickCommandTransport | null | undefined
  /** Same framing as a user paste into this pane: ConPTY can drop DECSET 2004, and input-record agents need modified Enter. */
  multilinePasteOptions: TerminalPasteTextOptions | undefined
  /** The pane's paste path: serializes with other pastes, rechecks the target and writes submitInput under the same lock; false means it already reported. */
  pasteText: (
    text: string,
    options: TerminalPasteTextOptions | undefined,
    submitInput: string | undefined
  ) => Promise<boolean>
  onError: (message: string) => void
}): Promise<boolean> {
  if (isTerminalAgentQuickCommand(command)) {
    return false
  }
  if (!transport) {
    return false
  }

  if (!/[\r\n]/.test(command.command)) {
    const sent = transport.sendInput(buildTerminalQuickCommandInput(command), 'driving')
    if (sent) {
      recordTerminalUserInputForLeaf(tabId, pane.leafId)
      pane.terminal.focus()
    }
    return sent
  }

  const framed =
    pane.terminal.modes.bracketedPasteMode ||
    multilinePasteOptions?.forceBracketedPasteForMultiline === true ||
    multilinePasteOptions?.windowsInputRecordNewline !== undefined
  // Insert must not run anything, and unframed newlines submit each line; Run may type them raw.
  if (!command.appendEnter && !framed) {
    onError(
      'This shell cannot safely receive a multiline command here. Use a script file or a shell with bracketed paste.'
    )
    return false
  }
  const text = normalizeTerminalQuickCommandText(command.command)
  if (!(await pasteText(text, multilinePasteOptions, command.appendEnter ? '\r' : undefined))) {
    return false
  }
  pane.terminal.focus()
  return true
}
