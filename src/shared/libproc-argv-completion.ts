import { runProcess } from '@orca/process-host'
import type { LibprocProcessRow } from './libproc-addon'
import { NODEV } from './libproc-ps-format'

const SZOMB_STATUS = 5
const MAX_ANCESTOR_DEPTH = 64

/** A pane descendant: on a terminal, under one of the user's own (argv-readable) processes on that terminal, e.g. `sudo` under the pane shell.
 * Root daemons have no terminal and a pane's root `login` sits under the terminal host, so neither costs a ps. */
function isOnUsersTerminal(
  row: LibprocProcessRow,
  byPid: ReadonlyMap<number, LibprocProcessRow>
): boolean {
  if (row.tdev === NODEV) {
    return false
  }
  let ancestor = byPid.get(row.ppid)
  for (let depth = 0; ancestor && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    if (ancestor.tdev === row.tdev && !ancestor.commandIncomplete) {
      return true
    }
    ancestor = ancestor.pid === ancestor.ppid ? undefined : byPid.get(ancestor.ppid)
  }
  return false
}

// Keyed by locale, pid and start time so a long-lived sudo agent costs one ps, not one per poll.
const authoritativeCommands = new Map<string, string>()
const AUTHORITATIVE_COMMAND_LIMIT = 512

function commandKey(ctype: string, row: LibprocProcessRow): string {
  return `${ctype}\0${row.pid}\0${row.startSec}`
}

/** Fill argv only setuid ps can read, for the rows this caller selected or that run on a user's terminal. */
export async function completeCommands(
  rows: LibprocProcessRow[],
  selectedByPid: boolean,
  ctype: string,
  env: NodeJS.ProcessEnv,
  deadline: number
): Promise<void> {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const needed = rows.filter(
    (row) =>
      row.commandIncomplete &&
      row.status !== SZOMB_STATUS &&
      (selectedByPid || isOnUsersTerminal(row, byPid))
  )
  const missing: LibprocProcessRow[] = []
  for (const row of needed) {
    const cached = authoritativeCommands.get(commandKey(ctype, row))
    if (cached === undefined) {
      missing.push(row)
    } else {
      row.command = cached
    }
  }
  const timeoutMs = deadline - Date.now()
  if (missing.length === 0 || timeoutMs <= 0) {
    return
  }
  let stdout: string
  try {
    const result = await runProcess({
      program: '/bin/ps',
      args: ['-ww', '-o', 'pid=,command=', '-p', missing.map((row) => row.pid).join(',')],
      env,
      timeoutMs,
      maxOutputBytes: 1024 * 1024
    })
    // Unreadable rows keep the executable path and retry next read.
    if (result.timedOut || result.outputTruncated || (result.code !== 0 && result.code !== 1)) {
      return
    }
    stdout = result.stdout
  } catch {
    return
  }
  const commands = new Map<number, string>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+) (.*)$/.exec(line)
    if (match) {
      commands.set(Number(match[1]), match[2])
    }
  }
  for (const row of missing) {
    const command = commands.get(row.pid)
    if (command === undefined) {
      continue
    }
    row.command = command
    for (const oldest of authoritativeCommands.keys()) {
      if (authoritativeCommands.size < AUTHORITATIVE_COMMAND_LIMIT) {
        break
      }
      authoritativeCommands.delete(oldest)
    }
    authoritativeCommands.set(commandKey(ctype, row), command)
  }
}
