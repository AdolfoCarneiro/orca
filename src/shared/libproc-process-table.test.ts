import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./darwin-terminal-names', () => ({
  nameDarwinTerminalDevices: async (devices: ReadonlySet<string>) =>
    new Map([...devices].filter((device) => device === '16/4').map((device) => [device, 'ttys004']))
}))

import {
  runPsInProcess,
  setLibprocAddonForTests,
  type LibprocAddon,
  type LibprocProcessRow
} from './libproc-process-table'
import { parseCheapProcessTableRows, parseStrictProcessTableRows } from './process-table-snapshot'

const TTYS004 = (16 << 24) | 4
// 2026-09-03T16:02:01Z, a single-digit day so lstart pads it.
const START = Date.UTC(2026, 8, 3, 16, 2, 1) / 1000

function row(overrides: Partial<LibprocProcessRow>): LibprocProcessRow {
  return {
    pid: 1,
    ppid: 0,
    pgid: 1,
    tpgid: 0,
    tdev: -1,
    status: 2,
    flags: 0,
    sessionLeader: false,
    startSec: START,
    comm: 'launchd',
    ...overrides
  }
}

const TABLE = [
  row({
    pid: 4300,
    ppid: 4242,
    pgid: 4300,
    tpgid: 4300,
    tdev: TTYS004,
    flags: 0x2,
    comm: 'node',
    command: 'node /usr/local/bin/claude --resume'
  }),
  row({
    pid: 4242,
    ppid: 4200,
    pgid: 4242,
    tpgid: 4300,
    tdev: TTYS004,
    flags: 0x2,
    sessionLeader: true,
    comm: 'zsh',
    command: '-zsh'
  }),
  row({
    pid: 4200,
    ppid: 1,
    pgid: 4200,
    tdev: TTYS004,
    flags: 0x2,
    comm: 'login',
    command: '/usr/bin/login'
  }),
  row({ pid: 4400, ppid: 4242, pgid: 4400, tpgid: 4300, status: 4, comm: 'vim', command: 'vim' }),
  row({ pid: 4401, ppid: 4242, pgid: 4401, status: 5, comm: 'sh', command: null })
]

function installAddon(overrides: Partial<LibprocAddon> = {}): LibprocAddon {
  const addon: LibprocAddon = {
    processTable: vi.fn(async (includeCommand: boolean, pids?: readonly number[]) =>
      TABLE.filter((entry) => !pids || pids.includes(entry.pid)).map((entry) =>
        includeCommand ? entry : { ...entry, command: undefined }
      )
    ),
    processCwd: vi.fn(() => null),
    processPath: vi.fn(() => null),
    ...overrides
  }
  setLibprocAddonForTests(addon)
  return addon
}

afterEach(() => {
  setLibprocAddonForTests(undefined)
})

describe('runPsInProcess', () => {
  it('prints a whole-table capture the strict and cheap parsers read like ps output', async () => {
    installAddon()
    const utc = { TZ: 'UTC0' }

    const full = await runPsInProcess(
      ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart=,command='],
      utc
    )
    expect(full?.code).toBe(0)
    expect(parseStrictProcessTableRows(full!.stdout)).toEqual([
      expect.objectContaining({ pid: 4200, stat: 'S', tty: 'ttys004', command: '/usr/bin/login' }),
      expect.objectContaining({ pid: 4242, stat: 'Ss', tty: 'ttys004', command: '-zsh' }),
      expect.objectContaining({
        pid: 4300,
        stat: 'S+',
        tty: 'ttys004',
        startTime: 'Thu Sep  3 16:02:01 2026',
        command: 'node /usr/local/bin/claude --resume'
      }),
      expect.objectContaining({ pid: 4400, stat: 'T', tty: '??', command: 'vim' }),
      expect.objectContaining({ pid: 4401, stat: 'Z', command: '(sh)' })
    ])

    const cheap = await runPsInProcess(['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,lstart='], utc)
    expect(parseCheapProcessTableRows(cheap!.stdout)[2]).toEqual({
      pid: 4300,
      ppid: 4242,
      pgid: 4300,
      tpgid: 4300,
      stat: 'S+',
      startTime: 'Thu Sep  3 16:02:01 2026'
    })
  })

  it('selects by pid or terminal and exits 1 like ps when nothing matches', async () => {
    const addon = installAddon()

    expect(await runPsInProcess(['-p', '4300', '-o', 'pid=,tdev='])).toMatchObject({
      code: 0,
      stdout: '4300 16/4\n'
    })
    expect(addon.processTable).toHaveBeenLastCalledWith(false, [4300])
    expect(await runPsInProcess(['-p', '9999', '-o', 'stat=,lstart='])).toMatchObject({
      code: 1,
      stdout: ''
    })
    const tty = await runPsInProcess(['-o', 'pid=,stat=', '-t', '/dev/ttys004'])
    expect(tty?.stdout).toBe('4200 S\n4242 Ss\n4300 S+\n')
  })

  it('keeps the real ps for invocations it cannot reproduce or a failing addon', async () => {
    installAddon()
    expect(await runPsInProcess(['-axo', 'pid=PROCESS_ID'])).toBeNull()
    expect(await runPsInProcess(['-axo', 'pid=,uid='])).toBeNull()
    expect(await runPsInProcess(['-p', '1', '-t', 'ttys004', '-o', 'pid='])).toBeNull()
    expect(await runPsInProcess(['-axo', 'lstart='], { TZ: 'America/New_York' })).toBeNull()

    installAddon({
      processTable: async () => {
        throw new Error('sysctl failed')
      }
    })
    expect(await runPsInProcess(['-axo', 'pid='])).toBeNull()

    setLibprocAddonForTests(null)
    expect(await runPsInProcess(['-axo', 'pid='])).toBeNull()
  })
})
