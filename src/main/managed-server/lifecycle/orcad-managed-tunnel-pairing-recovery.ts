// Only refusals sealed by the pinned key may trigger repair; foreign servers fail identity checks.
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { pairingRevisionOf, type ManagedOrcadPairingGate } from './orcad-managed-pairing-repair'
import { OrcadManagedPairingRejectedError } from './orcad-managed-tunnel-identity'
import {
  runtimeEnvironmentSetupFailure,
  type RuntimeEnvironmentSetupFailure
} from '../../../shared/runtime-environment-subscription-setup'
import type { SshSessionStartObserver } from '../../ssh/ssh-session-start-failure'

export type ManagedOrcadPairingRecovery = {
  resolve: (environmentId: string) => KnownRuntimeEnvironment
  repairs: ManagedOrcadPairingGate
  ensure: (
    environment: KnownRuntimeEnvironment,
    observeFailure?: SshSessionStartObserver
  ) => Promise<void>
}

/** Check cached refusal before building; permit one repair and rebuild on a refused pairing. */
export async function buildWithPairingRepair(
  recovery: ManagedOrcadPairingRecovery,
  environmentId: string,
  build: (
    environment: KnownRuntimeEnvironment,
    observeFailure?: SshSessionStartObserver
  ) => Promise<void>,
  observeFailure?: SshSessionStartObserver
): Promise<'built' | 'repaired'> {
  const refused = recovery.resolve(environmentId)
  const epoch = recovery.repairs.resetEpoch(environmentId)
  const standing = recovery.repairs.standingFailure(environmentId, pairingRevisionOf(refused))
  if (standing) {
    throw standing
  }
  let failure: RuntimeEnvironmentSetupFailure | undefined
  const observe: SshSessionStartObserver = (value) => {
    failure = value
  }
  const publish = (error: unknown) =>
    observeFailure?.(
      failure !== undefined && failure.error === error
        ? failure
        : runtimeEnvironmentSetupFailure(error, 'managed-preparation')
    )
  try {
    await (observeFailure ? build(refused, observe) : build(refused))
    return 'built'
  } catch (error) {
    if (!(error instanceof OrcadManagedPairingRejectedError)) {
      publish(error)
      throw error
    }
    console.warn('[managed-orcad] The Orca server refused this desktop; pairing again:', error)
  }
  // Revision matching joins already-completed repairs instead of repeating host work.
  const repaired = observeFailure
    ? await recovery.repairs
        .repairObserved(environmentId, pairingRevisionOf(refused))
        .then((outcome) => {
          if (!outcome.ok) {
            observeFailure(outcome.failure)
            throw outcome.failure.error
          }
          return outcome.value
        })
    : await recovery.repairs.repair(environmentId, pairingRevisionOf(refused))
  failure = undefined
  try {
    await (observeFailure ? recovery.ensure(repaired, observe) : recovery.ensure(repaired))
  } catch (error) {
    const finalError =
      error instanceof OrcadManagedPairingRejectedError
        ? recovery.repairs.recordRefusedAfterRepair(
            environmentId,
            pairingRevisionOf(repaired),
            epoch
          )
        : error
    publish(finalError)
    throw finalError
  }
  return 'repaired'
}
