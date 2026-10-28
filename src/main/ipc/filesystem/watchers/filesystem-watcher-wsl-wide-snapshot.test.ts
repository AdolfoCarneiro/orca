import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawnMock }))

import { createWslWatcher } from './filesystem-watcher-wsl'
import { resetWatcherChildRegistryForTest } from '../watcher-process/parcel-watcher-child-registry'

const ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const WIDE_ENTRIES = 150_000
const START = '\0\x1e\0'
const END = '\0\x1f\0'

class SnapshotChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => {
    this.emit('close', null, 'SIGTERM')
    return true
  })
}

function fileName(index: number): string {
  return `${'x'.repeat(64)}-${index}.ts`
}

function frame(count: number, changed = false): Buffer {
  const entries = Array.from({ length: count }, (_, index) =>
    changed && index === count - 1
      ? 'f\t2.0\t/home/me/repo/created.ts\0'
      : `f\t${changed && index === 0 ? '2.0' : '1.0'}\t/home/me/repo/${fileName(index)}\0`
  ).join('')
  return Buffer.from(`${START}${entries}${END}`)
}

function writeChunks(child: SnapshotChild, input: Buffer, chunkBytes: number): void {
  for (let offset = 0; offset < input.length; offset += chunkBytes) {
    child.stdout.write(input.subarray(offset, offset + chunkBytes))
  }
}

function start(signal?: AbortSignal): {
  child: SnapshotChild
  opening: ReturnType<typeof createWslWatcher>
  scheduleBatchFlush: ReturnType<typeof vi.fn>
} {
  const child = new SnapshotChild()
  const scheduleBatchFlush = vi.fn()
  spawnMock.mockReturnValueOnce(child)
  const opening = createWslWatcher(
    ROOT,
    ROOT,
    { ignoreDirs: [], watchedRoots: new Map(), scheduleBatchFlush },
    signal
  )
  return { child, opening, scheduleBatchFlush }
}

describe('WSL complete snapshot streaming', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    resetWatcherChildRegistryForTest()
  })

  it.each([
    { count: 2_500, chunkBytes: 65_536 },
    { count: WIDE_ENTRIES, chunkBytes: Number.MAX_SAFE_INTEGER },
    { count: WIDE_ENTRIES, chunkBytes: 65_536 }
  ])('starts from $count entries in $chunkBytes-byte chunks', async ({ count, chunkBytes }) => {
    const { child, opening, scheduleBatchFlush } = start()
    let ready = false
    void opening.then(() => {
      ready = true
    })
    const input = frame(count)
    writeChunks(child, input, chunkBytes)
    await new Promise(setImmediate)
    const readyFromCompleteFrame = ready
    if (!ready) {
      child.stdout.write(frame(1))
    }
    const root = await opening
    try {
      expect(readyFromCompleteFrame).toBe(true)
      expect(scheduleBatchFlush).not.toHaveBeenCalled()
      expect(root.batch.overflowed).toBe(false)
    } finally {
      await root.subscription.unsubscribe()
    }
  })

  it('publishes only complete wide snapshots and retains precise changes across their full width', async () => {
    const { child, opening, scheduleBatchFlush } = start()
    child.stdout.write(frame(WIDE_ENTRIES))
    const root = await opening
    try {
      const next = frame(WIDE_ENTRIES, true)
      writeChunks(child, next.subarray(0, next.length - END.length), 65_536)
      expect(root.batch.events).toEqual([])
      expect(scheduleBatchFlush).not.toHaveBeenCalled()

      writeChunks(child, next.subarray(next.length - END.length), 1)
      expect(root.batch.overflowed).toBe(false)
      expect(root.batch.events).toEqual([
        { type: 'update', path: `${ROOT}\\${fileName(0)}` },
        { type: 'create', path: `${ROOT}\\created.ts` },
        { type: 'delete', path: `${ROOT}\\${fileName(WIDE_ENTRIES - 1)}` }
      ])
      expect(scheduleBatchFlush).toHaveBeenCalledOnce()
    } finally {
      await root.subscription.unsubscribe()
    }
  })

  it.each([1, 2, 7])(
    'preserves UTF-8 and record/frame boundaries in %i-byte chunks',
    async (chunkBytes) => {
      const { child, opening } = start()
      writeChunks(child, Buffer.from(`${START}f\t1\t/home/me/repo/🐳文件.ts\0${END}`), chunkBytes)
      const root = await opening
      try {
        writeChunks(child, Buffer.from(`${START}f\t2\t/home/me/repo/🐳文件.ts\0${END}`), chunkBytes)
        expect(root.batch.events).toEqual([{ type: 'update', path: `${ROOT}\\🐳文件.ts` }])
      } finally {
        await root.subscription.unsubscribe()
      }
    }
  )

  it('discards an oversized unfinished record and recovers from the next complete frame', async () => {
    const { child, opening, scheduleBatchFlush } = start()
    child.stdout.write(frame(1))
    const root = await opening
    try {
      writeChunks(
        child,
        Buffer.from(`${START}f\t1\t/home/me/repo/phantom.ts\0${'x'.repeat(10 * 1024 * 1024 + 1)}`),
        65_536
      )
      expect(root.batch.overflowed).toBe(true)
      expect(root.batch.events).toEqual([])
      expect(scheduleBatchFlush).toHaveBeenCalledOnce()
      root.batch.overflowed = false
      child.stdout.write(`${END}${START}f\t2.0\t/home/me/repo/${fileName(0)}\0${END}`)
      expect(root.batch.events).toEqual([{ type: 'update', path: `${ROOT}\\${fileName(0)}` }])
    } finally {
      await root.subscription.unsubscribe()
    }
  })

  it('stops partial snapshot ingestion when unsubscribed', async () => {
    const { child, opening, scheduleBatchFlush } = start()
    child.stdout.write(frame(1))
    const root = await opening
    child.stdout.write(`${START}f\t2\t/home/me/repo/partial.ts\0`)
    await root.subscription.unsubscribe()
    child.stdout.write(END)
    child.stdout.write(frame(1, true))
    expect(root.batch.events).toEqual([])
    expect(scheduleBatchFlush).not.toHaveBeenCalled()
  })

  it('rejects startup canceled during a partial snapshot', async () => {
    const controller = new AbortController()
    const { child, opening } = start(controller.signal)
    child.stdout.write(`${START}f\t1\t/home/me/repo/partial.ts\0`)
    controller.abort()
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.kill).toHaveBeenCalledOnce()
  })
})
