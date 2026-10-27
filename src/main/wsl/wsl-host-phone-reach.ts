import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import type { WslHostConnector, WslHostReachability } from './wsl-host-connector-contract'
import {
  wslHostHiddenFromPhoneMessage,
  wslHostStoppedForPhoneMessage,
  wslHostUnavailableForPhoneMessage,
  wslHostRunRefusal
} from './wsl-host-add-admission'
import { focusReachability } from './wsl-host-focus-reachability'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostStatus } from '../../shared/wsl-host-types'

/** What a paired phone may know of a host: `stopped` only once a stop was confirmed. */
export type WslHostPhoneReach = 'hidden' | 'ready' | 'stopped' | 'unavailable'

/** Never probes or starts the distro: the desktop's own last verdict. */
export function wslHostPhoneReach(host: {
  mayRun: boolean
  state: string | undefined
  confirmedStopped: boolean
}): WslHostPhoneReach {
  if (!host.mayRun) {
    return 'hidden'
  }
  // A running list read after the last ready status outranks it.
  if (host.state === 'distro-stopped' || host.confirmedStopped) {
    return 'stopped'
  }
  return host.state === 'ready' ? 'ready' : 'unavailable'
}

export function wslHostPhoneRefusal(
  reach: WslHostPhoneReach,
  distro: string
): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError(
    'remote_runtime_unavailable',
    reach === 'stopped'
      ? wslHostStoppedForPhoneMessage(distro)
      : reach === 'hidden'
        ? wslHostHiddenFromPhoneMessage(distro)
        : wslHostUnavailableForPhoneMessage(distro)
  )
}

/** What a paired phone may reach through this desktop: a host that already runs, never a start. */
export class WslHostPhoneGate {
  // Stops a phone's check confirmed; a ready status clears them.
  private readonly confirmedStopped = new Set<string>()
  // Bumped per host on each ready status, so a running-list read that predates one is dropped.
  private readonly readyGeneration = new Map<string, number>()

  constructor(
    private readonly host: {
      service: {
        getStatuses(): readonly Pick<WslHostStatus, 'environmentId' | 'state'>[]
        onStatusesChanged(listener: () => void): () => void
        recordForEnvironment(
          environmentId: string
        ): Pick<WslHostDeploymentRecord, 'distro' | 'environmentId' | 'pendingStop'> | null
      }
      connector: Pick<WslHostConnector, 'get' | 'reachability'>
      isEnabled: () => boolean
      hasServerFiles: () => boolean
    }
  ) {
    host.service.onStatusesChanged(() => {
      for (const status of host.service.getStatuses()) {
        if (status.state === 'ready') {
          this.confirmedStopped.delete(status.environmentId)
          this.readyGeneration.set(
            status.environmentId,
            (this.readyGeneration.get(status.environmentId) ?? 0) + 1
          )
        }
      }
    })
  }

  /** A paired phone's call: serve a host that already runs, never start its distro for it. */
  async requireRunningWithoutStart(environmentId: string): Promise<void> {
    const refusal = wslHostRunRefusal(this.host)
    const record = this.host.service.recordForEnvironment(environmentId)
    if (refusal || record?.pendingStop) {
      throw wslHostPhoneRefusal('hidden', record?.distro ?? environmentId)
    }
    const generation = this.readyGeneration.get(environmentId)
    // Why: no bridge in this process means nothing answers, so skip the running-list read.
    const reachability: WslHostReachability = record
      ? await focusReachability(this.host.connector, record)
      : 'unreachable'
    if (reachability === 'available') {
      this.confirmedStopped.delete(environmentId)
      return
    }
    if (reachability === 'stopped' && this.readyGeneration.get(environmentId) === generation) {
      this.confirmedStopped.add(environmentId)
    }
    throw wslHostPhoneRefusal(this.reach(environmentId), record?.distro ?? environmentId)
  }

  /** What a phone is told of this host; never probes or starts the distro. */
  reach(environmentId: string): WslHostPhoneReach {
    const record = this.host.service.recordForEnvironment(environmentId)
    return wslHostPhoneReach({
      mayRun: wslHostRunRefusal(this.host) === null && !record?.pendingStop,
      state: this.host.service
        .getStatuses()
        .find((status) => status.environmentId === environmentId)?.state,
      confirmedStopped: this.confirmedStopped.has(environmentId)
    })
  }
}
