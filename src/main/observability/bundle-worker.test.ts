import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type * as WorkerThreads from 'node:worker_threads'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { collectBundle, type CollectBundleOptions } from './bundle'
import { collectBundleViaWorker, shutdownBundleWorker } from './bundle-worker-client'

const fixture = vi.hoisted(() => ({
  entry: '',
  workers: new Set<WorkerThreads.Worker>(),
  retirements: new Array<Promise<number>>()
}))
vi.mock('../worker-thread-entry-path', () => ({
  currentWorkerEntryLayout: () => ({}),
  resolveWorkerThreadEntryPath: () => fixture.entry
}))
vi.mock('node:worker_threads', async (importOriginal) => {
  const original = await importOriginal<typeof WorkerThreads>()
  return {
    ...original,
    Worker: class extends original.Worker {
      constructor(filename: string | URL) {
        super(filename)
        fixture.workers.add(this)
      }
      override terminate(): Promise<number> {
        const retired = super.terminate().finally(() => fixture.workers.delete(this))
        fixture.retirements.push(retired)
        return retired
      }
    }
  }
})

let root: string
let entry: string
let options: CollectBundleOptions
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-bundle-worker-'))
  entry = join(root, 'diagnostic-bundle-worker-entry.js')
  await build({
    entryPoints: [resolve('src/main/observability/bundle-worker-entry.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  options = {
    traceFilePath: join(root, 'trace.ndjson'),
    maxFiles: 10,
    daemonLogFilePath: join(root, 'daemon.log'),
    appVersion: 'fixture',
    platform: process.platform,
    arch: process.arch,
    osRelease: 'fixture',
    orcaChannel: 'dev'
  }
})
afterEach(async () => {
  shutdownBundleWorker()
  await Promise.all([...fixture.workers].map((worker) => worker.terminate()))
  await Promise.all(fixture.retirements.splice(0))
  vi.useRealTimers()
  vi.restoreAllMocks()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('collects rotated records in a real worker with the same order, redaction and cap', async () => {
  fixture.entry = entry
  const now = String(BigInt(Date.now()) * 1_000_000n)
  writeFileSync(
    options.traceFilePath,
    `${JSON.stringify({ name: 'old', endTimeUnixNano: '1' })}\nnot json\n` +
      `${JSON.stringify({ name: 'recent', endTimeUnixNano: now, authorization: 'secret', keep: '漢🙂' })}\r\n`
  )
  writeFileSync(
    `${options.traceFilePath}.1`,
    `${JSON.stringify({ name: 'rotated', endTimeUnixNano: now })}\n`
  )
  writeFileSync(
    join(root, 'daemon.log'),
    `${JSON.stringify({ src: 'daemon', ts: new Date().toISOString(), event: 'startup', detail: 'd'.repeat(4096) })}\n`.repeat(
      1500
    )
  )
  const expected = collectBundle(options)
  const actual = await collectBundleViaWorker(options)
  expect(actual.payload.split('\n').slice(1)).toEqual(expected.payload.split('\n').slice(1))
  expect(actual.payload).not.toContain('secret')
  expect(actual.payload).toContain('漢🙂')
  expect(actual.spanCount).toBe(expected.spanCount)
  expect(actual.bytes).toBe(Buffer.byteLength(actual.payload))
  expect(actual.bytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  expect(actual.bytes).toBeGreaterThan(3 * 1024 * 1024)
  expect(actual.bundleSubmissionId).toMatch(/^[A-Za-z0-9_-]{22}$/)
})

it('rejects a missing entry without falling back to synchronous collection', async () => {
  fixture.entry = join(root, 'missing.js')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await expect(collectBundleViaWorker(options)).rejects.toThrow('worker unavailable')
  expect(fixture.workers.size).toBe(0)
  fixture.entry = entry
  await expect(collectBundleViaWorker(options)).resolves.toHaveProperty('payload')
})

it('bounds queued requests and terminates unfinished work on shutdown', async () => {
  fixture.entry = join(root, 'hung.js')
  writeFileSync(fixture.entry, 'setInterval(() => {}, 1000)\n')
  const calls = Array.from({ length: 9 }, () => collectBundleViaWorker(options))
  const rejected = Promise.all(calls.map((call) => expect(call).rejects.toThrow('disposed')))
  await expect(collectBundleViaWorker(options)).rejects.toThrow('Too many')
  expect(fixture.workers.size).toBe(1)
  shutdownBundleWorker()
  await rejected
  await Promise.all(fixture.retirements)
  expect(fixture.workers.size).toBe(0)
})

it('retires a stalled worker at the deadline and permits a later collection', async () => {
  fixture.entry = join(root, 'hung.js')
  writeFileSync(fixture.entry, 'setInterval(() => {}, 1000)\n')
  vi.useFakeTimers()
  const pending = expect(collectBundleViaWorker(options)).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  await pending
  await Promise.all(fixture.retirements)
  vi.useRealTimers()
  fixture.entry = entry
  await expect(collectBundleViaWorker(options)).resolves.toHaveProperty('payload')
})

it('releases the idle worker and recreates it on the next collection', async () => {
  fixture.entry = entry
  vi.useFakeTimers()
  await collectBundleViaWorker(options)
  await vi.advanceTimersByTimeAsync(60_000)
  await Promise.all(fixture.retirements)
  expect(fixture.workers.size).toBe(0)
  vi.useRealTimers()
  await expect(collectBundleViaWorker(options)).resolves.toHaveProperty('payload')
  expect(fixture.workers.size).toBe(1)
})

it('returns collection errors without losing the worker or blocking its next request', async () => {
  fixture.entry = entry
  await expect(collectBundleViaWorker({ ...options, lookbackMinutes: Number.NaN })).rejects.toThrow(
    'BigInt'
  )
  await expect(collectBundleViaWorker(options)).resolves.toHaveProperty('payload')
  expect(fixture.workers.size).toBe(1)
})
