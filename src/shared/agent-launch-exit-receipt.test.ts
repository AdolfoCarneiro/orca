import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createLaunchExitReceiptScanner, withLaunchExitReceipt } from './agent-launch-exit-receipt'
import type { AgentStartupShell } from './tui-agent-startup-shell'

const RECEIPT_ID = '0123456789abcdef0123456789abcdef'

function hasCommand(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Each case runs a launch that dies by its own hand, then the receipt the shell prints after it.
const SHELLS: { shell: AgentStartupShell; run: string[]; agent: string; available: boolean }[] = [
  {
    shell: 'posix',
    run: ['sh', '-c'],
    agent: `sh -c 'kill -9 $$'`,
    available: process.platform !== 'win32'
  },
  {
    shell: 'powershell',
    run: ['pwsh', '-NoProfile', '-NonInteractive', '-Command'],
    agent: 'pwsh -NoProfile -Command exit 9',
    available: hasCommand('pwsh', ['-NoProfile', '-Command', 'exit 0'])
  },
  {
    shell: 'cmd',
    run: ['cmd.exe', '/d', '/c'],
    agent: 'cmd /c exit 9',
    available: process.platform === 'win32'
  }
]

describe('launch exit receipt', () => {
  it.each(SHELLS.filter((each) => each.available))(
    '$shell prints the receipt after its launch dies, and the scanner reads it across chunks',
    ({ shell, run, agent }) => {
      const [command, ...args] = run
      // The receipt is the line's last command, so the line succeeds whatever the launch did.
      const output = execFileSync(
        command,
        [...args, withLaunchExitReceipt(agent, RECEIPT_ID, shell)],
        { encoding: 'utf8' }
      )
      const seen: string[] = []
      const scanner = createLaunchExitReceiptScanner((id) => seen.push(id))
      const split = output.indexOf(RECEIPT_ID)
      scanner.scan(output.slice(0, split))
      scanner.scan(output.slice(split))
      expect(seen).toEqual([RECEIPT_ID])
    }
  )
})
