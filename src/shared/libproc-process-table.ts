import { nameDarwinTerminalDevices } from './darwin-terminal-names'
import {
  claimDarwinTerminalNaming,
  darwinTerminalNamingDrained
} from './darwin-terminal-naming-single-flight'
import {
  loadLibprocAddon,
  type LibprocAddon,
  type LibprocProcessRow,
  type LibprocQuery,
  type LibprocTableRead
} from './libproc-addon'
import { completeCommands } from './libproc-argv-completion'
import {
  compareLikePs,
  formatDarwinDevice,
  formatLibprocStat,
  formatLstart,
  parsePsQuery
} from './libproc-ps-format'

/** Shaped like a process-host ProcessResult so call sites can substitute it for ps's. */
export type LibprocPsResult = {
  code: 0 | 1 | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: ''
  timedOut: boolean
  outputTruncated: boolean
  /** When the native read began, never before the request: identity boundaries may rely on it. */
  startedAtMs?: number
}

export type InProcessPsOptions = {
  /** The environment ps would run with; its TZ and locale shape lstart and command escaping. */
  env?: NodeJS.ProcessEnv
  /** The caller's ps timeout: past it the read resolves timed out, as the killed ps would. */
  timeoutMs: number
  maxOutputBytes?: number
}

const TIMED_OUT: LibprocPsResult = {
  code: null,
  signal: 'SIGTERM',
  stdout: '',
  stderr: '',
  timedOut: true,
  outputTruncated: false
}

/** ps runs setlocale(LC_ALL, ""). */
function localeCategory(env: NodeJS.ProcessEnv, category: 'LC_CTYPE' | 'LC_TIME'): string {
  return env.LC_ALL || env[category] || env.LANG || 'C'
}

function lstartZoneIsUtc(env: NodeJS.ProcessEnv): boolean | null {
  const zone = env.TZ
  if (zone === undefined || zone === process.env.TZ) {
    return false
  }
  return /^(?:UTC|GMT)0?$/.test(zone) ? true : null
}

const DEADLINE_PASSED = Symbol('deadline')

async function beforeDeadline<T>(
  pending: Promise<T>,
  deadline: number
): Promise<T | typeof DEADLINE_PASSED> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<typeof DEADLINE_PASSED>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE_PASSED), Math.max(0, deadline - Date.now()))
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Identical reads share one worker; each caller still races its own deadline, so a stalled pool times them all out.
const nativeReadsInFlight = new Map<string, Promise<LibprocTableRead>>()
// Workers queued behind a saturated libuv pool would otherwise pile up one per poll.
const MAX_NATIVE_READS_IN_FLIGHT = 8

function startNativeRead(
  addon: LibprocAddon,
  query: LibprocQuery,
  key: string
): Promise<LibprocTableRead> | null {
  if (nativeReadsInFlight.size >= MAX_NATIVE_READS_IN_FLIGHT) {
    return null
  }
  const pending = addon.readProcessTable(query)
  nativeReadsInFlight.set(key, pending)
  const release = (): void => {
    if (nativeReadsInFlight.get(key) === pending) {
      nativeReadsInFlight.delete(key)
    }
  }
  pending.then(release, release)
  return pending
}

/** Rows read no earlier than `requestedAtMs`. A shared read that began before this request (an earlier
 * poll's abandoned one) is refused: its exited pids may since be reused, and teardown would signal them. */
async function readNativeTableSince(
  addon: LibprocAddon,
  query: LibprocQuery,
  requestedAtMs: number,
  deadline: number
): Promise<LibprocTableRead | typeof DEADLINE_PASSED> {
  const key = JSON.stringify(query)
  for (;;) {
    const pending = nativeReadsInFlight.get(key) ?? startNativeRead(addon, query, key)
    if (!pending) {
      // At the cap (a startup-restore burst, or a stalled pool): queue behind a read instead of bursting ps.
      const settled = Promise.race(nativeReadsInFlight.values()).then(
        () => {},
        () => {}
      )
      if ((await beforeDeadline(settled, deadline)) === DEADLINE_PASSED) {
        return DEADLINE_PASSED
      }
      continue
    }
    const read = await beforeDeadline(pending, deadline)
    if (read === DEADLINE_PASSED || read.startedAtMs >= requestedAtMs) {
      return read
    }
    if (nativeReadsInFlight.get(key) === pending) {
      nativeReadsInFlight.delete(key)
    }
  }
}

/** One naming pass at a time; wait out another (within the deadline) rather than burst /bin/ps at startup restore. */
async function nameTerminals(
  devices: ReadonlySet<string>,
  deadline: number
): Promise<ReadonlyMap<string, string> | typeof DEADLINE_PASSED> {
  for (;;) {
    const controller = new AbortController()
    const naming = claimDarwinTerminalNaming(() =>
      nameDarwinTerminalDevices(devices, undefined, controller.signal)
    )
    if (naming) {
      const named = await beforeDeadline(naming, deadline)
      if (named === DEADLINE_PASSED) {
        controller.abort()
      }
      return named
    }
    if ((await beforeDeadline(darwinTerminalNamingDrained(), deadline)) === DEADLINE_PASSED) {
      return DEADLINE_PASSED
    }
  }
}

/** ps output for `args`, read in process; null when the addon or the invocation is unsupported so callers run ps. */
export async function runPsInProcess(
  args: readonly string[],
  options: InProcessPsOptions
): Promise<LibprocPsResult | null> {
  const addon = loadLibprocAddon()
  const query = addon ? parsePsQuery(args) : null
  if (!addon || !query) {
    return null
  }
  const requestedAtMs = Date.now()
  const deadline = requestedAtMs + options.timeoutMs
  const env = options.env ?? process.env
  const utc = lstartZoneIsUtc(env)
  const needsLstart = query.columns.includes('lstart')
  // lstart is `%c`: only the C and en_US forms are reproduced.
  if (
    needsLstart &&
    (utc === null || !/^(?:C|POSIX|en_US(?:\..*)?)$/.test(localeCategory(env, 'LC_TIME')))
  ) {
    return null
  }
  const includeCommand = query.columns.includes('command')
  const ctype = localeCategory(env, 'LC_CTYPE')
  const nativeQuery: LibprocQuery = {
    command: includeCommand,
    ...(query.pids ? { pids: query.pids } : {}),
    ...(query.tty !== null ? { tty: query.tty } : {}),
    ...(includeCommand ? { ctype } : {})
  }
  let rows: LibprocProcessRow[] | null
  let startedAtMs: number
  let ttyNames: ReadonlyMap<string, string> = new Map()
  try {
    const read = await readNativeTableSince(addon, nativeQuery, requestedAtMs, deadline)
    if (read === DEADLINE_PASSED) {
      return TIMED_OUT
    }
    startedAtMs = read.startedAtMs
    // Shared reads hand every caller the same rows; command completion writes per caller.
    rows = read.rows?.map((row) => ({ ...row })) ?? null
    if (rows && query.columns.includes('tty')) {
      const devices = new Set(
        rows.map((row) => formatDarwinDevice(row.tdev)).filter((device) => device !== null)
      )
      if (devices.size > 0) {
        const named = await nameTerminals(devices, deadline)
        if (named === DEADLINE_PASSED) {
          return TIMED_OUT
        }
        ttyNames = named
      }
    }
    if (rows && includeCommand) {
      await completeCommands(rows, query.pids !== null, ctype, env, deadline)
    }
  } catch {
    return null
  }
  if (Date.now() > deadline) {
    return TIMED_OUT
  }
  // ps exits 1 when -t names no terminal or a -p/-t selection matched nothing.
  if (rows === null) {
    return { ...TIMED_OUT, code: 1, signal: null, timedOut: false, startedAtMs }
  }
  const ttyOf = (row: LibprocProcessRow): string =>
    ttyNames.get(formatDarwinDevice(row.tdev) ?? '') ?? '??'
  const selected = rows.sort(compareLikePs)
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
            return formatLstart(row.startSec, utc === true)
          case 'command':
            return row.command ?? `(${row.comm})`
          case 'pid':
          case 'ppid':
          case 'pgid':
          case 'tpgid':
            return String(row[column])
        }
      })
      .join(' ')
  )
  let stdout = lines.length > 0 ? `${lines.join('\n')}\n` : ''
  const maxBytes = options.maxOutputBytes
  const outputTruncated = maxBytes !== undefined && Buffer.byteLength(stdout, 'utf8') > maxBytes
  if (outputTruncated) {
    stdout = Buffer.from(stdout, 'utf8').subarray(0, maxBytes).toString('utf8')
  }
  return {
    code: query.pids === null && query.tty === null ? 0 : selected.length > 0 ? 0 : 1,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    outputTruncated,
    startedAtMs
  }
}

/** execFile-shaped: rejects on a nonzero exit or timeout like a failed ps child; null when ps must run. */
export async function readPsStdoutInProcess(
  args: readonly string[],
  options: InProcessPsOptions
): Promise<string | null> {
  const result = await runPsInProcess(args, options)
  if (!result) {
    return null
  }
  if (result.timedOut || result.code !== 0) {
    throw Object.assign(
      new Error(`Command failed: ps ${args.join(' ')}${result.timedOut ? ' (timed out)' : ''}`),
      { code: result.code, killed: result.timedOut, signal: result.signal }
    )
  }
  if (result.outputTruncated) {
    throw Object.assign(new Error(`ps ${args.join(' ')} exceeded maxBuffer`), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    })
  }
  return result.stdout
}
