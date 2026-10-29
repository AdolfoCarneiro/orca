import { createRequire } from 'node:module'
import { nameDarwinTerminalDevices } from './darwin-terminal-names'

/** One `kinfo_proc` from node-pty's patched macOS addon (config/patches/node-pty@1.1.0.patch). */
export type LibprocProcessRow = {
  pid: number
  ppid: number
  pgid: number
  tpgid: number
  /** `e_tdev`; -1 (NODEV) without a controlling terminal. */
  tdev: number
  /** `p_stat`: SIDL 1, SRUN 2, SSLEEP 3, SSTOP 4, SZOMB 5. */
  status: number
  flags: number
  sessionLeader: boolean
  startSec: number
  comm: string
  /** Joined KERN_PROCARGS2 argv, else the executable path for another user's process; null when neither is readable. */
  command?: string | null
}

export type LibprocAddon = {
  /** Reads on a worker thread; argv for a whole table costs ~17ms of syscalls. */
  processTable: (includeCommand: boolean, pids?: readonly number[]) => Promise<LibprocProcessRow[]>
  processCwd: (pid: number) => string | null
  processPath: (pid: number) => string | null
}

const requireFromHere = createRequire(__filename)
let cachedAddon: LibprocAddon | null | undefined
let addonOverride: LibprocAddon | null | undefined

function isLibprocAddon(native: unknown): native is LibprocAddon {
  return (
    typeof native === 'object' &&
    native !== null &&
    'processTable' in native &&
    typeof native.processTable === 'function' &&
    'processCwd' in native &&
    typeof native.processCwd === 'function' &&
    'processPath' in native &&
    typeof native.processPath === 'function'
  )
}

/** The in-process reader, or null where ps/lsof must still run (non-macOS, an unpatched or unloadable node-pty).
 * Vitest keeps the subprocess path so ps fixtures stay authoritative. */
export function loadLibprocAddon(): LibprocAddon | null {
  if (addonOverride !== undefined) {
    return addonOverride
  }
  if (process.platform !== 'darwin' || process.env.VITEST === 'true') {
    return null
  }
  if (cachedAddon !== undefined) {
    return cachedAddon
  }
  try {
    const utils: unknown = requireFromHere('node-pty/lib/utils')
    const native: unknown =
      typeof utils === 'object' &&
      utils !== null &&
      'loadNativeModule' in utils &&
      typeof utils.loadNativeModule === 'function'
        ? utils.loadNativeModule('pty')?.module
        : null
    cachedAddon = isLibprocAddon(native) ? native : null
  } catch {
    cachedAddon = null
  }
  if (cachedAddon === null) {
    // A packaging regression would otherwise silently restore one setuid ps exec per poll (#31783).
    console.warn('[process-table] node-pty lacks the libproc reader; falling back to ps and lsof')
  }
  return cachedAddon
}

export function setLibprocAddonForTests(addon: LibprocAddon | null | undefined): void {
  addonOverride = addon
}

const SIDL = 1
const SSTOP = 4
const SZOMB = 5
const P_CONTROLT = 0x2
const P_WEXIT = 0x2000
const NODEV = -1

/** ps's state letters, except running vs sleeping: that needs another task's thread states (ps is setuid for it), so live processes read `S`. */
export function formatLibprocStat(row: LibprocProcessRow): string {
  const state =
    row.status === SZOMB ? 'Z' : row.status === SSTOP ? 'T' : row.status === SIDL ? 'R' : 'S'
  return (
    state +
    (row.flags & P_WEXIT && row.status !== SZOMB ? 'E' : '') +
    (row.sessionLeader ? 's' : '') +
    (row.flags & P_CONTROLT && row.pgid === row.tpgid ? '+' : '')
  )
}

export function formatDarwinDevice(tdev: number): string | null {
  return tdev === NODEV ? null : `${(tdev >>> 24) & 0xff}/${tdev & 0xffffff}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** ps `lstart` (`%c` in the C and en_US locales): `Thu Sep  3 16:02:01 2026`. */
export function formatLstart(startSec: number, utc: boolean): string {
  const date = new Date(startSec * 1000)
  const [weekday, month, day, hours, minutes, seconds, year] = utc
    ? [
        date.getUTCDay(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
        date.getUTCFullYear()
      ]
    : [
        date.getDay(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
        date.getFullYear()
      ]
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${WEEKDAYS[weekday]} ${MONTHS[month]} ${String(day).padStart(2, ' ')} ${two(hours)}:${two(minutes)}:${two(seconds)} ${year}`
}

const COLUMN_ALIASES: Readonly<Record<string, Column>> = {
  pid: 'pid',
  ppid: 'ppid',
  pgid: 'pgid',
  tpgid: 'tpgid',
  stat: 'stat',
  state: 'stat',
  tdev: 'tdev',
  tty: 'tty',
  lstart: 'lstart',
  command: 'command',
  args: 'command'
}

type Column = 'pid' | 'ppid' | 'pgid' | 'tpgid' | 'stat' | 'tdev' | 'tty' | 'lstart' | 'command'

export type PsQuery = {
  columns: Column[]
  pids: number[] | null
  tty: string | null
}

/** The `ps` invocations Orca issues (`-axo`, `-e -o`, `-p`, `-t`, empty headers); anything else returns null and keeps the real ps. */
export function parsePsQuery(args: readonly string[]): PsQuery | null {
  const columns: Column[] = []
  let all = false
  let pids: number[] | null = null
  let tty: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const value = (): string | undefined => args[++index]
    if (arg === '-axo' || arg === '-o') {
      all ||= arg === '-axo'
      const spec = value()
      if (spec === undefined) {
        return null
      }
      for (const field of spec.split(',')) {
        const match = /^([a-z]+)=$/.exec(field)
        const column = match ? COLUMN_ALIASES[match[1]] : undefined
        if (!column) {
          return null
        }
        columns.push(column)
      }
    } else if (arg === '-ax' || arg === '-A' || arg === '-e') {
      all = true
    } else if (arg === '-ww') {
      continue
    } else if (arg === '-p') {
      const list = value()?.split(',').map(Number)
      if (!list || list.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
        return null
      }
      pids = [...(pids ?? []), ...list]
    } else if (arg === '-t') {
      const name = value()?.replace(/^\/dev\//, '')
      if (!name) {
        return null
      }
      tty = name
    } else {
      return null
    }
  }
  // ps unions selections; Orca never combines them, so keep the real ps for that.
  const selections = Number(all) + Number(pids !== null) + Number(tty !== null)
  return columns.length > 0 && selections === 1 ? { columns, pids, tty } : null
}

/** Shaped like a process-host ProcessResult so call sites can substitute it for ps's. */
export type LibprocPsResult = {
  code: 0 | 1
  signal: null
  stdout: string
  stderr: ''
  timedOut: false
  outputTruncated: false
}

function sanitizeCommand(command: string): string {
  return command.replace(/[\r\n\t]/g, ' ')
}

function readCommand(row: LibprocProcessRow): string {
  return sanitizeCommand(row.command?.trim() ? row.command : `(${row.comm})`)
}

function lstartZoneIsUtc(env: NodeJS.ProcessEnv | undefined): boolean | null {
  const zone = env?.TZ
  if (zone === undefined || zone === process.env.TZ) {
    return false
  }
  return /^(?:UTC|GMT)0?$/.test(zone) ? true : null
}

/** ps output for `args`, read in process; null when the addon or the invocation is unsupported so callers run ps. */
export async function runPsInProcess(
  args: readonly string[],
  env?: NodeJS.ProcessEnv
): Promise<LibprocPsResult | null> {
  const addon = loadLibprocAddon()
  const query = addon ? parsePsQuery(args) : null
  const utc = lstartZoneIsUtc(env)
  if (!addon || !query || utc === null) {
    return null
  }
  const needsTty = query.columns.includes('tty') || query.tty !== null
  let rows: LibprocProcessRow[]
  let ttyNames: ReadonlyMap<string, string> = new Map()
  try {
    rows = await addon.processTable(query.columns.includes('command'), query.pids ?? undefined)
    if (needsTty) {
      const devices = new Set(
        rows.map((row) => formatDarwinDevice(row.tdev)).filter((device) => device !== null)
      )
      ttyNames = await nameDarwinTerminalDevices(devices)
    }
  } catch {
    return null
  }
  const ttyOf = (row: LibprocProcessRow): string =>
    ttyNames.get(formatDarwinDevice(row.tdev) ?? '') ?? '??'
  const selected = (query.tty === null ? rows : rows.filter((row) => ttyOf(row) === query.tty))
    .slice()
    .sort((a, b) => a.pid - b.pid)
  const lines = selected.map((row) =>
    query.columns
      .map((column) => {
        switch (column) {
          case 'stat':
            return formatLibprocStat(row)
          case 'tdev':
            return formatDarwinDevice(row.tdev) ?? '??'
          case 'tty':
            return ttyOf(row)
          case 'lstart':
            return formatLstart(row.startSec, utc)
          case 'command':
            return readCommand(row)
          case 'pid':
          case 'ppid':
          case 'pgid':
          case 'tpgid':
            return String(row[column])
        }
      })
      .join(' ')
  )
  // ps exits 1 when a -p/-t selection matched nothing.
  return {
    code: query.pids === null && query.tty === null ? 0 : selected.length > 0 ? 0 : 1,
    signal: null,
    stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    stderr: '',
    timedOut: false,
    outputTruncated: false
  }
}

/** PROC_PIDVNODEPATHINFO cwd, or undefined when only lsof can answer. */
export function readLibprocProcessCwd(pid: number): string | null | undefined {
  const addon = loadLibprocAddon()
  if (!addon) {
    return undefined
  }
  try {
    return addon.processCwd(pid)
  } catch {
    return undefined
  }
}

/** proc_pidpath executable, or undefined when only lsof can answer. */
export function readLibprocProcessPath(pid: number): string | null | undefined {
  const addon = loadLibprocAddon()
  if (!addon) {
    return undefined
  }
  try {
    return addon.processPath(pid)
  } catch {
    return undefined
  }
}
