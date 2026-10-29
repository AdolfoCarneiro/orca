import { win32 as pathWin32 } from 'node:path'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { codexCommandLineJoinsSharedServer } from '../../shared/codex-shared-server-command'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex,
  type ProcessIdentityRow
} from '../../shared/process-table-index'
import { getProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import { readWindowsProcessTable } from '../windows/windows-process-table'
import { fishArgsSkipConfig } from '../fish-xdg-data-dirs-handoff'
import {
  getObservedCodexPaneHome,
  isCurrentCodexPaneObservation
} from './codex-pane-account-registry'
import type { CodexPaneHomeObservation } from './codex-pane-account-registry-types'
import { probeCodexSharedServer } from './codex-shared-server-probe'

type CommandRow = ProcessIdentityRow & { command: string; name?: string }

export type PaneCodexProcess = {
  command: string
  /** Lowercase parent process name, or null if absent or unwrapped fish. */
  shell: string | null
}

// Windows rows may have an image name but no command line.
function executableName(row: CommandRow): string {
  const executable = row.name || row.command.trim().split(/\s+/)[0] || ''
  return pathWin32
    .basename(executable)
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()
}

/** The outermost launcher carries the argv; its children may include a shared server. */
export function findPaneCodex(
  rows: readonly CommandRow[],
  rootPid: number
): PaneCodexProcess | null {
  const index = getProcessTableIndex(rows)
  let outermost: (CommandRow & { depth: number }) | null = null
  for (const row of collectDescendantsFromIndex(index, rootPid)) {
    if (
      (!outermost || row.depth < outermost.depth) &&
      recognizeAgentProcessFromCommandLine(row.command, { includeHeadlessOneShot: true })?.agent ===
        'codex'
    ) {
      outermost = row
    }
  }
  if (!outermost) {
    return null
  }
  const parent = index.byPid.get(outermost.ppid)
  const shell = parent ? executableName(parent) : null
  // Fish without config never loads Orca's Codex wrapper.
  const unwrappedFish =
    shell === 'fish' && fishArgsSkipConfig(parent?.command.trim().split(/\s+/).slice(1) ?? [])
  return { command: outermost.command, shell: unwrappedFish ? null : shell }
}

/** Launch-time home only; later shell exports are not observed. */
export function resolveCodexPaneHome(ptyId: string): string | null {
  const observed = getObservedCodexPaneHome(ptyId)
  return observed?.frozenOrigin.selectionKey === 'host' && observed.frozenOrigin.accountId === null
    ? observed.actualHome
    : null
}

export async function findPaneCodexOnSharedServer(
  ptyId: string,
  rootPid: number,
  observation: CodexPaneHomeObservation | null = getObservedCodexPaneHome(ptyId),
  isCurrent = () => observation !== null && isCurrentCodexPaneObservation(ptyId, observation)
): Promise<PaneCodexProcess | null> {
  const codexHome =
    observation?.frozenOrigin.selectionKey === 'host' && observation.frozenOrigin.accountId === null
      ? observation.actualHome
      : null
  if (!codexHome || !isCurrent()) {
    return null
  }
  const rows: readonly CommandRow[] =
    process.platform === 'win32' ? await readWindowsProcessTable() : await getProcessTableSnapshot()
  if (!isCurrent()) {
    return null
  }
  const codex = findPaneCodex(rows, rootPid)
  return codex &&
    codexCommandLineJoinsSharedServer(codex.command) &&
    (await probeCodexSharedServer(codexHome)) === 'live' &&
    isCurrent()
    ? codex
    : null
}
