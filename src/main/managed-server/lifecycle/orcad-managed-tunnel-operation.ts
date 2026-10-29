import {
  runtimeEnvironmentSetupFailure,
  type RuntimeEnvironmentSetupFailure,
  type RuntimeEnvironmentSetupOutcome
} from '../../../shared/runtime-environment-subscription-setup'
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { isAuthError } from '../../ssh/ssh-reconnect-error-classification'
import type { SshSessionStartObserver } from '../../ssh/ssh-session-start-failure'

export function ensureManagedTunnelOperation(
  environment: KnownRuntimeEnvironment,
  retryJoined: boolean,
  inFlight: Map<string, Promise<RuntimeEnvironmentSetupOutcome<void>>>,
  build: (observeFailure: SshSessionStartObserver) => Promise<void>
): Promise<RuntimeEnvironmentSetupOutcome<void>> {
  if (!getRuntimeSshAccess(environment)) {
    return Promise.resolve({ ok: true, value: undefined })
  }
  const pending = inFlight.get(environment.id)
  if (pending) {
    // Retry joined runs cancelled by another caller; authentication failures remain authoritative.
    return pending.then((outcome) =>
      !outcome.ok &&
      retryJoined &&
      !(outcome.failure.error instanceof Error && isAuthError(outcome.failure.error))
        ? ensureManagedTunnelOperation(environment, false, inFlight, build)
        : outcome
    )
  }
  let failure: RuntimeEnvironmentSetupFailure | undefined
  const operation = build((value) => {
    failure = value
  })
    .then<RuntimeEnvironmentSetupOutcome<void>, RuntimeEnvironmentSetupOutcome<void>>(
      () => ({ ok: true, value: undefined }),
      (error: unknown) => ({
        ok: false,
        failure: failure ?? runtimeEnvironmentSetupFailure(error, 'managed-preparation')
      })
    )
    .finally(() => {
      if (inFlight.get(environment.id) === operation) {
        inFlight.delete(environment.id)
      }
    })
  inFlight.set(environment.id, operation)
  return operation
}
