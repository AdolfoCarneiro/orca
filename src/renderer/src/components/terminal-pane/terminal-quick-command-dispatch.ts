import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import {
  buildTerminalQuickCommandInput,
  isTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
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
  forceBracketedMultilinePaste,
  onError
}: {
  command: TerminalQuickCommand
  pane: QuickCommandPane
  tabId: string
  transport: QuickCommandTransport | null | undefined
  /** Windows clients: ConPTY can drop DECSET 2004, so frame multiline text like a user paste. */
  forceBracketedMultilinePaste: boolean
  onError: (message: string) => void
}): boolean {
  if (isTerminalAgentQuickCommand(command)) {
    return false
  }
  if (!transport) {
    return false
  }

  const bracketedPasteSafe = pane.terminal.modes.bracketedPasteMode || forceBracketedMultilinePaste
  // Insert must not run anything, and unframed newlines submit each line; Run may type them raw.
  if (!command.appendEnter && /[\r\n]/.test(command.command) && !bracketedPasteSafe) {
    onError(
      'This shell cannot safely receive a multiline command here. Use a script file or a shell with bracketed paste.'
    )
    return false
  }

  const sent = transport.sendInput(
    buildTerminalQuickCommandInput(command, { bracketedPasteSafe }),
    'driving'
  )
  if (sent) {
    recordTerminalUserInputForLeaf(tabId, pane.leafId)
    pane.terminal.focus()
  }
  return sent
}
