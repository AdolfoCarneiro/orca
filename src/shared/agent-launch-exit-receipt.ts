/** A launch-bound marker the shell prints once the launched agent returns, however it ended (exit, crash, SIGKILL). */

import { ownRetainedString } from './own-retained-string'
import type { AgentStartupShell } from './tui-agent-startup-shell'

const RECEIPT_PREFIX = '\x1b]7503;orca-launch-exit;'
const RECEIPT_ID = /^[0-9a-f]{32}$/
// oxlint-disable-next-line no-control-regex -- the receipt is an ESC…BEL OSC by definition.
const RECEIPT = /\x1b\]7503;orca-launch-exit;([0-9a-f]{32})\x07/g
const RECEIPT_LENGTH = RECEIPT_PREFIX.length + 32 + 1

/** Terminals ignore this private OSC; the typed line holds only its escaped spelling, so echo cannot match. */
export function withLaunchExitReceipt(
  command: string,
  receiptId: string,
  shell: AgentStartupShell
): string {
  if (!RECEIPT_ID.test(receiptId)) {
    throw new Error('withLaunchExitReceipt: receipt id must be 32 lowercase hex characters')
  }
  // Single-quoted printf parses alike in sh, bash, zsh, dash and fish; `$?` would not parse in fish.
  if (shell === 'posix') {
    return `${command}; printf '\\033]7503;orca-launch-exit;${receiptId}\\007'`
  }
  const write = `Write-Host -NoNewline ([string][char]27+']7503;orca-launch-exit;${receiptId}'+[char]7)`
  if (shell === 'powershell') {
    return `${command}; ${write}`
  }
  // cmd's echo cannot emit ESC, and a typed ESC clears its line.
  return `${command} & powershell.exe -NoLogo -NoProfile -NonInteractive -Command ${write}`
}

export type LaunchExitReceiptScanner = {
  scan: (data: string) => void
  reset: () => void
}

export function createLaunchExitReceiptScanner(
  onReceipt: (receiptId: string) => void
): LaunchExitReceiptScanner {
  // Only an ESC-led tail shorter than a full receipt can continue into the next chunk.
  let carry = ''
  return {
    scan(data) {
      if (!carry && !data.includes('\x1b')) {
        return
      }
      const text = carry + data
      let scannedTo = 0
      if (text.includes(RECEIPT_PREFIX)) {
        for (const match of text.matchAll(RECEIPT)) {
          onReceipt(match[1])
          scannedTo = match.index + match[0].length
        }
      }
      const escape = text.lastIndexOf('\x1b')
      carry =
        escape >= scannedTo && text.length - escape < RECEIPT_LENGTH
          ? ownRetainedString(text.slice(escape))
          : ''
    },
    reset() {
      carry = ''
    }
  }
}
