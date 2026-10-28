import {
  normalizeTerminalPasteLineEndings,
  wrapTerminalBracketedPasteText
} from '../../../src/shared/terminal-bracketed-paste-text'
import type { TerminalModes } from './terminal-webview-contract'

// Match xterm's paste(): newlines become CR, and DECSET 2004 frames the text with ESC made inert.
export function buildMobileTerminalPasteText(
  text: string,
  modes: TerminalModes | undefined
): string {
  return modes?.bracketedPasteMode === true
    ? wrapTerminalBracketedPasteText(text)
    : normalizeTerminalPasteLineEndings(text)
}
