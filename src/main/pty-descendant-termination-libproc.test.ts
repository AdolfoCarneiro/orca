import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setLibprocAddonForTests,
  type LibprocProcessRow,
  type LibprocQuery,
  type LibprocTableRead
} from '../shared/libproc-addon'
import { captureDescendantSnapshot, killWithDescendantSweep } from './pty-descendant-termination'

const START = Date.UTC(2026, 8, 3, 16, 2, 1) / 1000
// Fixed read start times on either side of any request: one long before, one after.
const ABANDONED_READ_STARTED_AT_MS = 0
const FRESH_READ_STARTED_AT_MS = Date.UTC(2100, 0, 1)

function row(pid: number, ppid: number): LibprocProcessRow {
  return {
    pid,
    ppid,
    pgid: pid,
    tpgid: 0,
    tdev: -1,
    status: 3,
    flags: 0,
    sessionLeader: false,
    startSec: START,
    comm: 'node'
  }
}

afterEach(() => {
  setLibprocAddonForTests(undefined)
})

describe('descendant teardown over the in-process process table', () => {
  it('never signals a reused pid from an earlier poll’s abandoned native read', async () => {
    let finishAbandoned: (read: LibprocTableRead) => void = () => {}
    const abandoned = new Promise<LibprocTableRead>((resolve) => {
      finishAbandoned = resolve
    })
    const readProcessTable = vi
      .fn<(query: LibprocQuery) => Promise<LibprocTableRead>>()
      .mockReturnValueOnce(abandoned)
      // Since that read began, descendant 200 exited and an unrelated process took its pid.
      .mockImplementation(async () => ({
        startedAtMs: FRESH_READ_STARTED_AT_MS,
        rows: [row(1, 0), row(100, 1), row(200, 1)]
      }))
    setLibprocAddonForTests({
      readProcessTable,
      processCwd: () => null,
      processPath: () => null
    })
    expect(await captureDescendantSnapshot(100, { timeoutMs: 10 })).toBeNull()

    const sendSignal = vi.fn()
    const killRoot = vi.fn()
    const teardown = killWithDescendantSweep(100, killRoot, {
      sendSignal,
      timeoutMs: 1_000,
      graceMs: 60_000
    })
    finishAbandoned({
      startedAtMs: ABANDONED_READ_STARTED_AT_MS,
      rows: [row(1, 0), row(100, 1), row(200, 100)]
    })
    await teardown

    expect(killRoot).toHaveBeenCalledOnce()
    expect(sendSignal).not.toHaveBeenCalled()
    expect(readProcessTable).toHaveBeenCalledTimes(2)
  })
})
