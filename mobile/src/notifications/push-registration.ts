import {
  readRecords,
  mutateRecords,
  resetRegistrationRecords
} from './mobile-push-registration-records'
import { registerMobilePushTarget, type HostPushState } from './mobile-push-host-target'
import { AppState } from 'react-native'
import {
  saveNotificationDeliveryPreferences,
  type NotificationDeliveryPreferences
} from './notification-delivery-preferences'
import { NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'
import { pushRouteUnregister } from './mobile-push-registration-operations'
import { loadPushNotificationsEnabled, savePushNotificationsEnabled } from '../storage/preferences'
import { createMobilePushOwner, type MobilePushOwner } from './mobile-push-token-owner'

export const NOTIFICATIONS_REMOTE_PUSH_CAPABILITY = NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY

type PushClient = RpcOperationSender

const REQUEST_TIMEOUT_MS = 5_000
const REMOVAL_TIMEOUT_MS = 2_000

const hostsById = new Map<string, HostPushState>()
let owner: MobilePushOwner | undefined
// A late registration must not overwrite a newer preference or consent choice.
let consentGeneration = 0
let localOperations = 0

function hostState(hostId: string): HostPushState {
  let state = hostsById.get(hostId)
  if (!state) {
    state = {
      connection: { client: null },
      supported: null,
      capabilityProbeStop: null,
      chain: Promise.resolve()
    }
    hostsById.set(hostId, state)
  }
  return state
}

async function sendUnregister(client: PushClient, timeoutMs: number): Promise<boolean> {
  const reply = await pushRouteUnregister
    .request(client, null, { timeoutMs, failWhenDisconnected: true })
    .catch(() => null)
  return reply !== null && pushRouteUnregister.interpret(reply).accepted
}

async function reconcileHost(hostId: string): Promise<void> {
  const state = hostsById.get(hostId)
  const client = state?.connection.client
  if (!state || !client || localOperations > 0) {
    return
  }
  const root = owner
  const generation = consentGeneration
  const isCurrent = () => hostsById.get(hostId) === state && state.connection.client === client
  const dispatchCurrent = () =>
    localOperations === 0 && generation === consentGeneration && isCurrent()
  const value = await readRecords()
  if (!dispatchCurrent()) {
    return
  }
  // Unregister intent takes priority even before the capability probe answers.
  if (value.pending.has(hostId)) {
    if (state.supported === false || !(await sendUnregister(client, REQUEST_TIMEOUT_MS))) {
      return
    }
    if (!dispatchCurrent()) {
      return
    }
    state.target = { root, client, target: 'disabled', acknowledged: true }
    await mutateRecords((current) => {
      if (dispatchCurrent()) {
        current.pending.delete(hostId)
        current.registered.delete(hostId)
      }
    })
    // A preference change can invalidate a register without disabling push.
    if (!dispatchCurrent()) {
      return
    }
    if (!(await loadPushNotificationsEnabled()) || !dispatchCurrent()) {
      return
    }
  }
  if (state.supported == null) {
    if (!dispatchCurrent()) {
      return
    }
    state.capabilityProbeStop ??= startRuntimeCapabilityProbe(client, (capabilities) => {
      if (!isCurrent()) {
        return
      }
      state.supported = capabilities.includes(NOTIFICATIONS_REMOTE_PUSH_CAPABILITY)
      state.routeKeySupported = capabilities.includes('notifications.push-route-key.v1')
      enqueueReconcile(hostId)
    })
    return
  }
  if (!state.supported || !dispatchCurrent()) {
    return
  }
  const enabled = await loadPushNotificationsEnabled()
  if (!dispatchCurrent()) {
    return
  }
  if (!enabled) {
    if (root && root.isCurrent()) {
      root.enabled = false
    }
    // Saved consent recovers a disable even if its pending-record write failed.
    if (
      state.target?.client !== client ||
      state.target.target !== 'disabled' ||
      !state.target.acknowledged
    ) {
      if (!(await sendUnregister(client, REQUEST_TIMEOUT_MS)) || !dispatchCurrent()) {
        return
      }
      state.target = { root, client, target: 'disabled', acknowledged: true }
    }
    await mutateRecords((current) => {
      if (dispatchCurrent()) {
        current.pending.delete(hostId)
        current.registered.delete(hostId)
      }
    })
    return
  }
  if (!root || !root.isCurrent() || AppState.currentState !== 'active') {
    return
  }
  const result = await registerMobilePushTarget(root, state, client, generation, isCurrent)
  if (
    result === 'stale' &&
    isCurrent() &&
    (generation !== consentGeneration || owner === undefined)
  ) {
    await mutateRecords((current) => {
      if (isCurrent()) {
        current.pending.add(hostId)
      }
    })
    state.dirty = true
  } else if (result === true && dispatchCurrent()) {
    await mutateRecords((current) => {
      if (owner === root && root.isCurrent() && dispatchCurrent()) {
        current.registered.add(hostId)
      }
    })
  }
}

function enqueueReconcile(hostId: string): void {
  const state = hostsById.get(hostId)
  if (!state) {
    return
  }
  state.preparation?.releaseIfObsolete()
  state.dirty = true
  if (!state.running) {
    state.running = true
    state.chain = (async () => {
      while (state.dirty && hostsById.get(hostId) === state) {
        state.dirty = false
        try {
          await reconcileHost(hostId)
        } catch {
          console.warn('[push] Failed to reconcile notification registration')
        }
      }
      if (!state.target?.acknowledged) {
        state.target = undefined
      }
      state.running = false
    })()
  }
}

function reconcileAllHosts(): void {
  for (const hostId of hostsById.keys()) {
    enqueueReconcile(hostId)
  }
}

// Keep tracked host intent across disconnects; this disposer detaches only its current connected client.
export function attachPushRegistration(hostId: string, client: PushClient): () => void {
  const state = hostState(hostId)
  if (state.connection.client !== client) {
    state.capabilityProbeStop?.()
    state.capabilityProbeStop = null
    state.connection.client = client
    state.supported = null
    state.preparation?.releaseIfObsolete()
  }
  if (owner && !owner.token) {
    owner.refresh()
  }
  enqueueReconcile(hostId)
  const connection = state.connection
  return () => {
    if (connection.client === client) {
      connection.client = null
      state.capabilityProbeStop?.()
      state.capabilityProbeStop = null
      state.supported = null
      state.preparation?.releaseIfObsolete()
      const current = hostsById.get(hostId)
      if (current && current !== state) {
        current.capabilityProbeStop?.()
        current.capabilityProbeStop = null
        current.supported = null
        current.preparation?.releaseIfObsolete()
      }
    }
  }
}

// Consent completion covers local persistence; host reconciliation runs in the background.
export async function setRemotePushEnabled(enabled: boolean): Promise<void> {
  localOperations++
  invalidateIntent()
  try {
    await savePushNotificationsEnabled(enabled)
    await mutateRecords((current) => {
      if (!enabled) {
        for (const hostId of current.registered) {
          current.pending.add(hostId)
        }
      } else {
        current.pending.clear()
      }
    })
  } finally {
    completeLocalOperation()
  }
}

export async function setNotificationDeliveryPreferences(
  value: NotificationDeliveryPreferences
): Promise<void> {
  localOperations++
  invalidateIntent()
  try {
    await saveNotificationDeliveryPreferences(value)
  } finally {
    completeLocalOperation()
  }
}

function completeLocalOperation(): void {
  localOperations--
  if (localOperations === 0) {
    rederiveOwner()
  }
}

// Offline hosts retain the registration until unpaired or its mobile-use lease expires.
export async function unregisterPushForRemovedHost(hostId: string): Promise<() => void> {
  const state = hostsById.get(hostId)
  // Retire ownership before waiting for earlier RPCs to settle.
  hostsById.delete(hostId)
  state?.preparation?.releaseIfObsolete()
  state?.capabilityProbeStop?.()
  if (state) {
    state.target = undefined
    state.capabilityProbeStop = null
  }
  await state?.chain
  if (hostsById.has(hostId)) {
    return () => {}
  }
  if (state?.connection.client && state.supported !== false) {
    await sendUnregister(state.connection.client, REMOVAL_TIMEOUT_MS)
  }
  await mutateRecords((current) => {
    if (!hostsById.has(hostId)) {
      current.registered.delete(hostId)
      current.pending.delete(hostId)
    }
  }).catch(() => {})
  return () => {
    if (state && !hostsById.has(hostId)) {
      // Preserve disconnect ownership without reviving stale registration work.
      hostsById.set(hostId, { ...state, supported: null, capabilityProbeStop: null })
      enqueueReconcile(hostId)
    }
  }
}

function invalidateIntent(): void {
  consentGeneration++
  owner?.invalidate()
}

function rederiveOwner(): void {
  owner?.rederive()
  reconcileAllHosts()
}

export function startPushTokenSync(): () => void {
  owner?.stop()
  const root = createMobilePushOwner(
    () => owner === root,
    () => consentGeneration,
    () => localOperations === 0,
    () => {
      for (const state of hostsById.values()) {
        state.preparation?.releaseIfObsolete()
      }
      reconcileAllHosts()
    }
  )
  owner = root
  root.start()
  return () => {
    if (owner === root) {
      owner = undefined
    }
    root.stop()
  }
}

export function resetPushRegistrationForTests(): void {
  owner?.stop()
  owner = undefined
  hostsById.clear()
  resetRegistrationRecords()
  consentGeneration = 0
  localOperations = 0
}

export function pushRegistrationSnapshotForTests() {
  return {
    preparations: [...hostsById.values()].filter((state) => state.preparation !== undefined).length,
    runners: [...hostsById.values()].filter((state) => state.running).length
  }
}
