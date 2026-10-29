import { ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import { resolvePinnedFederatedServer } from '../worker/worker-observation'
import { releaseFederatedWorker, resolveExecutionHostCapability } from './federated-worker-release'

/** The home's deadline for a host that predates automatic release; the host's retain and takeover still refuse it. */
export async function releaseFederatedWorkerAtHomeDeadline(
  runtime: WorkerTerminalReleaseRuntime,
  dispatchId: string
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  const federated = db.getFederatedDispatch(dispatchId)
  if (!federated) {
    return
  }
  try {
    const args = {
      runtime,
      server: resolvePinnedFederatedServer(runtime, federated),
      federated,
      dispatchId,
      requestId: `home_auto_release_${dispatchId}_${Date.now()}`
    }
    // A host upgraded since settlement owns its own deadline.
    const hostReleases = await resolveExecutionHostCapability(
      args,
      ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY
    )
    if (
      !hostReleases.supported &&
      (await releaseFederatedWorker(args)).state === 'release_unknown'
    ) {
      db.retryFederatedHomeAutoRelease(dispatchId)
      return
    }
  } catch (error) {
    db.retryFederatedHomeAutoRelease(dispatchId)
    throw error
  }
  db.endFederatedHomeAutoRelease(dispatchId)
}
