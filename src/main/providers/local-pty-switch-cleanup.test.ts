import { afterEach, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { LocalPtyProvider } from './local-pty-provider'
import {
  ptyProcesses,
  ptyIncarnations,
  ptyShellPath,
  ptyPhysicalExits,
  LocalPtyPhysicalExit,
  clearPtyState
} from './local-pty-provider-state'
import type * as PtyDescendantTerminationModule from '../pty-descendant-termination'
import type * as ProcessTableSnapshotReaderModule from '../../shared/process-table-snapshot-reader'

const table = vi.hoisted(() => vi.fn())
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessTableSnapshotReaderModule>()),
  getProcessTableSnapshot: async () => (await table()).rows,
  getStrictProcessTableSnapshotWithAge: () => table()
}))
vi.mock('../pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: (_pid: number, killRoot: () => void) => killRoot(),
  forceKillPosixPtyProcessGroupsSync: (_pid: number, killRoot: () => void) => killRoot()
}))
vi.mock('../pty-descendant-termination', async (importOriginal) => {
  const sweep = await importOriginal<typeof PtyDescendantTerminationModule>()
  return {
    ...sweep,
    killWithDescendantSweep: (
      pid: number,
      killRoot: () => void,
      options: Parameters<typeof sweep.killWithDescendantSweep>[2]
    ) =>
      sweep.killWithDescendantSweep(pid, killRoot, {
        ...options,
        platform: 'linux',
        readTable: async () => {
          await table()
          return { rows: [], capturedAtMs: 0 }
        }
      })
  }
})
const id = 'switch-cleanup-fixture'
const incarnation = '45454545-4545-4545-8545-454545454545'
const shell: ProcessTableRow = {
  pid: 12000,
  ppid: 1,
  pgid: 12000,
  tpgid: 12000,
  tty: 'pts/7',
  stat: 'Ss+',
  command: '/bin/zsh'
}
const snapshot = (rows: ProcessTableRow[]) => ({ rows, capturedAgeMs: 0 })
afterEach(() => {
  clearPtyState(id)
  vi.restoreAllMocks()
  table.mockReset()
})
function setup() {
  const owner = new LocalPtyPhysicalExit()
  const kill = vi.fn(() => {
    owner.markExited()
    clearPtyState(id)
  })
  const proc: IPty = {
    pid: shell.pid,
    cols: 80,
    rows: 24,
    process: 'zsh',
    handleFlowControl: false,
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: () => {},
    clear: () => {},
    pause: () => {},
    resume: () => {},
    kill
  }
  ptyProcesses.set(id, proc)
  ptyIncarnations.set(id, incarnation)
  ptyShellPath.set(id, '/bin/zsh')
  ptyPhysicalExits.set(id, owner)
  owner.witness = {
    token: 'captured-before-probe',
    at: performance.now(),
    revision: owner.useRevision
  }
  table.mockResolvedValue(snapshot([shell]))
  return { provider: new LocalPtyProvider(), proc, owner, kill }
}
const request = () => ({
  id,
  expectedIncarnationId: incarnation,
  requireNoAgentOwner: true,
  requireUnattached: false,
  switchCondition: {
    token: 'captured-before-probe',
    remainingMs: 10_000,
    ownedSpawn: true as const
  }
})

it.each(['input', 'attachment', 'preparing launch'] as const)(
  'keeps the real local owner usable when %s races the final probe',
  async (change) => {
    const { provider, proc, kill } = setup()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    table.mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return snapshot([shell])
    })
    const closing = provider.killFenced(request())
    await entered.promise
    if (change === 'input') {
      expect(provider.write(id, 'codex\r')).toBe(true)
    }
    if (change === 'attachment') {
      await provider.attach(id)
    }
    let releaseLaunch: (() => void) | undefined
    let launching: Promise<unknown> | undefined
    if (change === 'preparing launch') {
      const { runCancelableLocalPtySpawn } = await import('./local-pty-spawn-state')
      const wait = Promise.withResolvers<void>()
      releaseLaunch = wait.resolve
      launching = runCancelableLocalPtySpawn(id, () => wait.promise)
    }
    release.resolve()
    expect(await closing).toMatchObject({ outcome: 'refused' })
    expect(kill).not.toHaveBeenCalled()
    expect(ptyProcesses.get(id)).toBe(proc)
    expect(provider.write(id, 'echo still here\r')).toBe(true)
    releaseLaunch?.()
    await launching
  }
)
it('cleans up only a captured unused new spawn; obsolete source-shell witnesses never authorize it', async () => {
  const { provider, kill } = setup()
  const sourceRequest = {
    ...request(),
    switchCondition: { token: 'captured-before-probe', remainingMs: 10_000 }
  }
  expect(await provider.killFenced(sourceRequest)).toEqual({
    outcome: 'refused',
    reason: 'unsupported'
  })
  expect(kill).not.toHaveBeenCalled()
  expect(await provider.killFenced(request())).toEqual({ outcome: 'ended' })
  expect(kill).toHaveBeenCalledOnce()
})
