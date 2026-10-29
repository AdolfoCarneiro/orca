import { parentPort } from 'node:worker_threads'
import { collectBundle } from './bundle'
import type { BundleWorkerRequest, BundleWorkerResponse } from './bundle-worker-protocol'

if (!parentPort) {
  throw new Error('Diagnostic bundle worker requires a parent port.')
}
const port = parentPort

port.on('message', (request: BundleWorkerRequest) => {
  let response: BundleWorkerResponse
  try {
    response = { id: request.id, ok: true, bundle: collectBundle(request.options) }
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  port.postMessage(response)
})
