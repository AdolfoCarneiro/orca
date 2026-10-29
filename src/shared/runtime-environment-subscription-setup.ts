import type { RuntimeRpcResponse } from './runtime-rpc-envelope'

/** Local setup facts; remote protocol and saved host records do not carry them. */
type SetupFact =
  | { kind: 'cancelled' | 'source-retired' | 'manual-disconnect' | 'input' | 'host-unsupported' }
  | {
      kind: 'wsl'
      reason:
        | 'launch-closed'
        | 'disabled'
        | 'server-files-missing'
        | 'pending-stop'
        | 'parked'
        | 'removing'
        | 'unavailable'
        | 'launch-deferred'
        | 'not-running'
    }
  | {
      kind: 'binding'
      reason:
        | 'missing-dependency'
        | 'services-unavailable'
        | 'registration-changed'
        | 'wrong-owner'
        | 'wrong-port'
    }
  | {
      kind: 'ssh'
      decision:
        | 'stopped'
        | 'exhausted-transient'
        | 'busy'
        | 'retired'
        | 'manual-disconnect'
        | 'credential-declined'
    }
  | { kind: 'remote'; code: string }
  | {
      kind: 'operation'
      operation: 'environment-resolution' | 'managed-preparation' | 'subscription'
    }

export type CrewSetupFact = Readonly<SetupFact>

export type CrewSubscriptionSetupResult =
  | { subscriptionId: string; ok: true }
  | {
      subscriptionId: string
      ok: false
      failure: { message: string; code?: string; fact: CrewSetupFact }
    }

export type CrewSubscriptionAttemptArgs = {
  subscriptionId: string
  selector: string
  method: 'orchestration.crewSubscribe'
  params?: unknown
  timeoutMs?: number
  expectedEnvironmentPairingRevision: number
  expectedEnvironmentRuntimeId: string | null
}

/** A fresh guard's fact belongs to that occurrence, never to a reused external Error. */
export class RuntimeEnvironmentSetupGuardError extends Error {
  constructor(
    message: string,
    readonly setupFact: CrewSetupFact
  ) {
    super(message)
  }
}

export type RuntimeEnvironmentSetupFailure = Readonly<{
  error: unknown
  fact: CrewSetupFact
}>

export type RuntimeEnvironmentSetupOutcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: RuntimeEnvironmentSetupFailure }>

export function runtimeEnvironmentSetupFailure(
  error: unknown,
  operation: Extract<CrewSetupFact, { kind: 'operation' }>['operation']
): RuntimeEnvironmentSetupFailure {
  return {
    error,
    fact:
      error instanceof RuntimeEnvironmentSetupGuardError
        ? error.setupFact
        : { kind: 'operation', operation }
  }
}

export type CrewSubscriptionAttemptCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}

export function isCrewSetupFact(value: unknown): value is CrewSetupFact {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false
  }
  switch (value.kind) {
    case 'cancelled':
    case 'source-retired':
    case 'manual-disconnect':
    case 'input':
    case 'host-unsupported':
      return true
    case 'remote':
      return 'code' in value && typeof value.code === 'string'
    case 'wsl':
      return (
        'reason' in value &&
        (value.reason === 'launch-closed' ||
          value.reason === 'disabled' ||
          value.reason === 'server-files-missing' ||
          value.reason === 'pending-stop' ||
          value.reason === 'parked' ||
          value.reason === 'removing' ||
          value.reason === 'unavailable' ||
          value.reason === 'launch-deferred' ||
          value.reason === 'not-running')
      )
    case 'binding':
      return (
        'reason' in value &&
        (value.reason === 'missing-dependency' ||
          value.reason === 'services-unavailable' ||
          value.reason === 'registration-changed' ||
          value.reason === 'wrong-owner' ||
          value.reason === 'wrong-port')
      )
    case 'ssh':
      return (
        'decision' in value &&
        (value.decision === 'stopped' ||
          value.decision === 'exhausted-transient' ||
          value.decision === 'busy' ||
          value.decision === 'retired' ||
          value.decision === 'manual-disconnect' ||
          value.decision === 'credential-declined')
      )
    case 'operation':
      return (
        'operation' in value &&
        (value.operation === 'environment-resolution' ||
          value.operation === 'managed-preparation' ||
          value.operation === 'subscription')
      )
    default:
      return false
  }
}
