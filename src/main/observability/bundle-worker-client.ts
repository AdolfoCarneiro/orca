import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import type { CollectedBundle, CollectBundleOptions } from './bundle'
import type { BundleWorkerRequest, BundleWorkerResponse } from './bundle-worker-protocol'

const WORKER_FILENAME = 'diagnostic-bundle-worker-entry.js'
const WORKER_TIMEOUT_MS = 5 * 60_000
const IDLE_TEARDOWN_MS = 60_000

function createWorker(): Worker {
  const path = resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_FILENAME)
  if (!existsSync(path)) {
    throw new Error(`Diagnostic bundle worker entry not found: ${path}`)
  }
  return new Worker(path)
}

let queue: WorkerThreadRequestQueue<BundleWorkerRequest, BundleWorkerResponse> | null = null

function getQueue(): WorkerThreadRequestQueue<BundleWorkerRequest, BundleWorkerResponse> {
  queue ??= new WorkerThreadRequestQueue({
    factory: createWorker,
    idleTeardownMs: IDLE_TEARDOWN_MS,
    maxConsecutiveDeaths: 3,
    queueCap: {
      maxQueuedCalls: 8,
      describeFull: () => 'Too many diagnostic bundle collections are pending; try again later'
    },
    awaitRetirement: true,
    createUnavailableError: (message) =>
      new Error(`Diagnostic bundle worker unavailable: ${message}`),
    describeTimeout: (timeoutMs) => `Diagnostic bundle worker timed out after ${timeoutMs}ms`,
    describeExit: (code) => `Diagnostic bundle worker exited with code ${code}`,
    describeCrashLoop: (error) => `Diagnostic bundle worker crashed repeatedly: ${error}`,
    onUnavailable: (error) => console.warn('[observability] Bundle worker unavailable:', error)
  })
  return queue
}

export async function collectBundleViaWorker(
  options: CollectBundleOptions
): Promise<CollectedBundle> {
  const response = await getQueue().dispatch((id) => ({ id, options }), WORKER_TIMEOUT_MS)
  if (!response.ok) {
    throw new Error(response.error)
  }
  return response.bundle
}

export function shutdownBundleWorker(): void {
  queue?.dispose()
  queue = null
}
