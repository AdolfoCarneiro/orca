import { randomUUID } from 'node:crypto'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RemoteRuntimeSubscription } from '../../../shared/remote-runtime/remote-runtime-client'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { isAbortSignalReason, throwIfSignalAborted } from '../../../shared/abort-signal-reason'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import {
  RuntimeEnvironmentSetupGuardError,
  runtimeEnvironmentSetupFailure,
  type CrewSubscriptionSetupResult,
  type RuntimeEnvironmentSetupFailure
} from '../../../shared/runtime-environment-subscription-setup'
import {
  resolveEnvironment,
  RuntimeEnvironmentStoreError
} from '../../../shared/runtime-environment-store'
import { OrcadHostUnsupportedError } from '../../orcad/orcad-host-unavailable'
import {
  WslDistroNotRunningError,
  WslOrcadLaunchDeferredError
} from '../../wsl/wsl-orcad-connection-errors'
import {
  OrcadManagedIdentityError,
  OrcadManagedPairingRejectedError
} from '../../managed-server/lifecycle/orcad-managed-tunnel-identity'
import { OrcadManagedPairingRepairFailedError } from '../../managed-server/lifecycle/orcad-managed-pairing-repair-failure'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-connectivity-handlers'

export type RuntimeEnvironmentSubscribeArgs = {
  selector: string
  method: string
  params?: unknown
  timeoutMs?: number
  subscriptionId?: string
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string | null
  setupResult?: 'crew'
}

export function assertCrewSubscriptionInputs(
  args: RuntimeEnvironmentSubscribeArgs,
  crewResult: boolean,
  subscriptionId: string,
  remoteRuntimeSubscriptions: ReadonlyMap<string, unknown>,
  pendingSubscriptions: ReadonlyMap<string, unknown>
): void {
  if (
    crewResult &&
    (args.method !== 'orchestration.crewSubscribe' ||
      typeof args.subscriptionId !== 'string' ||
      args.subscriptionId.length === 0 ||
      typeof args.expectedEnvironmentPairingRevision !== 'number' ||
      !Number.isFinite(args.expectedEnvironmentPairingRevision) ||
      !(
        args.expectedEnvironmentRuntimeId === null ||
        typeof args.expectedEnvironmentRuntimeId === 'string'
      ))
  ) {
    throw new RuntimeEnvironmentSetupGuardError('Invalid crew subscription setup inputs', {
      kind: 'input'
    })
  }
  if (remoteRuntimeSubscriptions.has(subscriptionId) || pendingSubscriptions.has(subscriptionId)) {
    throw new RuntimeEnvironmentSetupGuardError(
      'Runtime environment subscription id already exists',
      { kind: 'input' }
    )
  }
}

export function resolveSubscriptionEnvironment(
  userDataPath: string,
  args: RuntimeEnvironmentSubscribeArgs,
  crewResult: boolean
) {
  const environment = resolveEnvironment(userDataPath, args.selector)
  if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
    throw new RuntimeEnvironmentSetupGuardError('runtime_manually_disconnected', {
      kind: 'manual-disconnect'
    })
  }
  const pairingRevision = environment.pairingRevision ?? environment.createdAt
  if (
    args.expectedEnvironmentPairingRevision !== undefined &&
    pairingRevision !== args.expectedEnvironmentPairingRevision
  ) {
    throw new RuntimeEnvironmentSetupGuardError(
      'Runtime environment pairing changed; refresh and try again',
      { kind: 'source-retired' }
    )
  }
  if (
    args.expectedEnvironmentRuntimeId !== undefined &&
    (!crewResult || args.expectedEnvironmentRuntimeId !== null) &&
    environment.runtimeId !== args.expectedEnvironmentRuntimeId
  ) {
    throw new RuntimeEnvironmentSetupGuardError(
      'Runtime environment identity changed; refresh and try again',
      { kind: 'source-retired' }
    )
  }
  return { environment, pairingRevision }
}

export function assertCrewSubscriptionCurrent(
  event: IpcMainInvokeEvent,
  sender: WebContents,
  getUserDataPath: () => string,
  environment: ReturnType<typeof resolveEnvironment>,
  pairingRevision: number,
  args: RuntimeEnvironmentSubscribeArgs,
  transportIsCurrent: () => boolean,
  signal: AbortSignal,
  observeFailure: (failure: RuntimeEnvironmentSetupFailure) => void
): void {
  throwIfSignalAborted(signal)
  if (
    sender.isDestroyed() ||
    !event.senderFrame ||
    event.senderFrame.detached ||
    event.senderFrame !== sender.mainFrame
  ) {
    throw new RuntimeEnvironmentSetupGuardError(
      'The window that started this subscription went away',
      { kind: 'source-retired' }
    )
  }
  if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
    throw new RuntimeEnvironmentSetupGuardError('runtime_manually_disconnected', {
      kind: 'manual-disconnect'
    })
  }
  let current: ReturnType<typeof resolveEnvironment>
  try {
    current = resolveEnvironment(getUserDataPath(), environment.id)
  } catch (error) {
    observeFailure(runtimeEnvironmentSetupFailure(error, 'environment-resolution'))
    throw error
  }
  if (
    !transportIsCurrent() ||
    (current.pairingRevision ?? current.createdAt) !== pairingRevision ||
    (args.expectedEnvironmentRuntimeId != null &&
      current.runtimeId !== args.expectedEnvironmentRuntimeId)
  ) {
    throw new RuntimeEnvironmentSetupGuardError(
      'Runtime environment pairing changed; refresh and try again',
      { kind: 'source-retired' }
    )
  }
}

export function crewSubscriptionSetupFailure(
  subscriptionId: string,
  error: unknown,
  failure: RuntimeEnvironmentSetupFailure | undefined,
  operation: 'environment-resolution' | 'subscription',
  setupSignal: AbortSignal | undefined
): CrewSubscriptionSetupResult {
  const observed =
    error instanceof RuntimeEnvironmentSetupGuardError
      ? { error, fact: error.setupFact }
      : failure !== undefined && failure.error === error
        ? failure
        : runtimeEnvironmentSetupFailure(error, operation)
  const fact = isAbortSignalReason(setupSignal, error)
    ? { kind: 'cancelled' as const }
    : error instanceof RuntimeEnvironmentStoreError && error.code === 'invalid_argument'
      ? { kind: 'input' as const }
      : error instanceof OrcadHostUnsupportedError
        ? { kind: 'host-unsupported' as const }
        : error instanceof WslOrcadLaunchDeferredError
          ? { kind: 'wsl' as const, reason: 'launch-deferred' as const }
          : error instanceof WslDistroNotRunningError
            ? { kind: 'wsl' as const, reason: 'not-running' as const }
            : error instanceof RemoteRuntimeClientError ||
                error instanceof OrcadManagedIdentityError ||
                error instanceof OrcadManagedPairingRejectedError ||
                error instanceof OrcadManagedPairingRepairFailedError
              ? { kind: 'remote' as const, code: error.code }
              : observed.fact
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  return {
    subscriptionId,
    ok: false,
    failure: {
      message: error instanceof Error ? error.message : String(error),
      ...(code === undefined ? {} : { code }),
      fact
    }
  }
}

export type RetainedRemoteRuntimeSubscription = RemoteRuntimeSubscription & {
  setupController: AbortController
  environmentId: string
  ownerWebContentsId: number
  disposeRendererLifetime: () => void
  notifyClosed: () => void
}
export type PendingRuntimeSubscription = {
  ownerWebContentsId: number
  environmentId: string
  close: () => void
}

export function assertSubscriptionPairingCurrent(
  getUserDataPath: () => string,
  environment: ReturnType<typeof resolveEnvironment>,
  pairingRevision: number,
  transportIsCurrent: () => boolean,
  crewResult: boolean,
  disposeRendererLifetime: () => void,
  subscription: RemoteRuntimeSubscription,
  observeFailure: (failure: RuntimeEnvironmentSetupFailure) => void
): void {
  let pairingIsCurrent = false
  try {
    const currentEnvironment = resolveEnvironment(getUserDataPath(), environment.id)
    pairingIsCurrent =
      (currentEnvironment.pairingRevision ?? currentEnvironment.createdAt) === pairingRevision
  } catch (error) {
    if (crewResult) {
      disposeRendererLifetime()
      subscription.close()
      observeFailure(runtimeEnvironmentSetupFailure(error, 'environment-resolution'))
      throw error
    }
    pairingIsCurrent = false
  }
  if (!transportIsCurrent() || !pairingIsCurrent) {
    disposeRendererLifetime()
    subscription.close()
    throw new RuntimeEnvironmentSetupGuardError(
      'Runtime environment pairing changed; refresh and try again',
      { kind: 'source-retired' }
    )
  }
}

export type RuntimeEnvironmentSubscriptionHandlerDependencies = {
  getUserDataPath: () => string
  remoteRuntimeSubscriptions: Map<string, RetainedRemoteRuntimeSubscription>
  pendingSubscriptions: Map<string, PendingRuntimeSubscription>
  createAssociationObserver?: (
    environmentId: string,
    identity: string
  ) => { observe: (frame: unknown) => void; dispose: () => void }
  recordLayoutFrame: (
    environmentId: string,
    method: string,
    response: RuntimeRpcResponse<unknown>
  ) => void
}

export function runtimeEnvironmentSubscriptionId(args: RuntimeEnvironmentSubscribeArgs): string {
  return typeof args.subscriptionId === 'string' && args.subscriptionId.length > 0
    ? args.subscriptionId
    : randomUUID()
}

export function assertSettledCrewSubscriptionCurrent(
  crewResult: boolean,
  assertCrewCurrent: () => void,
  disposeRendererLifetime: () => void,
  subscription: RemoteRuntimeSubscription
): void {
  if (crewResult) {
    try {
      assertCrewCurrent()
    } catch (error) {
      disposeRendererLifetime()
      subscription.close()
      throw error
    }
  }
}

export type {
  CrewSubscriptionSetupResult,
  RuntimeEnvironmentSetupFailure
} from '../../../shared/runtime-environment-subscription-setup'
