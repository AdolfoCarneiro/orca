import { spawn, spawnSync } from 'node:child_process'
import { RuntimeClientError } from './runtime-client-error'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { readMacosBundleId, resetMacosTccPermission } from '../macos-tcc-reset'
import { resolveMacOSComputerUseAppPath } from './macos-native-provider-paths'
import { resolveComputerUseHelperUnavailableReason } from './macos-computer-use-permission-status'
import { computerUsePermissionStatusGate } from './macos-computer-use-permission-status-gate'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionResetResult,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'

const DEFAULT_COMPUTER_USE_BUNDLE_ID = 'com.stablyai.orca.computer-use'

export { getComputerUsePermissionStatus } from './macos-computer-use-permission-status'

// One setup-helper spawn per 5s across every permission, on the monotonic clock; claimed synchronously.
const SETUP_HELPER_LAUNCH_WINDOW_MS = 5_000
// Requests are numbered when they arrive so latest-wins holds even for ones that coalesce.
type SetupLaunchRequest = { seq: number; helperAppPath: string; helperArgs: string[] }
let setupRequestSeq = 0
let lastLaunchedSeq = 0
let lastSetupLaunchAt = Number.NEGATIVE_INFINITY
let queuedSetupLaunch: SetupLaunchRequest | null = null
let queuedSetupTimer: ReturnType<typeof setTimeout> | null = null
// Bumped by reset and shutdown so Opens still waiting on status never launch afterwards.
let setupGeneration = 0
let setupShuttingDown = false
let shutdownHookInstalled = false
type PendingSetupRequest = { seq: number; key: string; generation: number }
const setupInFlight = new Map<
  string,
  { request: PendingSetupRequest; promise: Promise<ComputerUsePermissionSetupResult> }
>()

export function openComputerUsePermissions(
  permissionId?: ComputerUsePermissionId
): Promise<ComputerUsePermissionSetupResult> {
  installSetupShutdownHook()
  const key = permissionId ?? 'all'
  const seq = ++setupRequestSeq
  const existing = setupInFlight.get(key)
  if (existing) {
    existing.request.seq = seq
    return existing.promise
  }
  const request: PendingSetupRequest = { seq, key, generation: setupGeneration }
  const promise = openComputerUsePermissionsAsync(permissionId, request).finally(() => {
    if (setupInFlight.get(key)?.request === request) {
      setupInFlight.delete(key)
    }
  })
  setupInFlight.set(key, { request, promise })
  return promise
}

// Drops queued and still-preflighting launches, e.g. on reset, so no helper appears after the user moved on.
export function cancelQueuedSetupHelperLaunch(): void {
  setupGeneration += 1
  clearQueuedSetupLaunch()
}

export function stopComputerUseSetupForShutdown(): void {
  setupShuttingDown = true
  cancelQueuedSetupHelperLaunch()
}

// Every host (desktop, headless Electron serve, orcad) runs AppEnvironment quit handlers.
function installSetupShutdownHook(): void {
  if (shutdownHookInstalled || !hasAppEnvironment()) {
    return
  }
  shutdownHookInstalled = true
  getAppEnvironment().onWillQuit(stopComputerUseSetupForShutdown)
}

function clearQueuedSetupLaunch(): void {
  if (queuedSetupTimer) {
    clearTimeout(queuedSetupTimer)
    queuedSetupTimer = null
  }
  queuedSetupLaunch = null
}

// Launches now, or queues for when the window reopens; a later request supersedes a queued one.
function requestSetupHelperLaunch(request: SetupLaunchRequest): 'launched' | 'queued' {
  const waitMs = lastSetupLaunchAt + SETUP_HELPER_LAUNCH_WINDOW_MS - performance.now()
  if (waitMs <= 0 && !queuedSetupLaunch) {
    launchSetupHelper(request)
    return 'launched'
  }
  if (!queuedSetupLaunch || request.seq > queuedSetupLaunch.seq) {
    queuedSetupLaunch = request
  }
  if (!queuedSetupTimer) {
    queuedSetupTimer = setTimeout(
      () => {
        const queued = queuedSetupLaunch
        clearQueuedSetupLaunch()
        // A launch that started after this request already showed what the user asked for last.
        if (queued && queued.seq > lastLaunchedSeq) {
          launchSetupHelper(queued)
        }
      },
      Math.max(0, waitMs)
    )
    queuedSetupTimer.unref?.()
  }
  return 'queued'
}

function launchSetupHelper(request: SetupLaunchRequest): void {
  if (setupShuttingDown) {
    return
  }
  lastLaunchedSeq = Math.max(lastLaunchedSeq, request.seq)
  // Kill and relaunch so a repeated click always brings the helper back to the front.
  closeExistingPermissionHelpers()
  const helper = spawn(
    '/usr/bin/open',
    ['-n', request.helperAppPath, '--args', ...request.helperArgs],
    { detached: true, stdio: 'ignore' }
  )
  // Measured after the spawn so a slow pkill can't pull the next spawn inside the window.
  lastSetupLaunchAt = performance.now()
  helper.unref()
}

async function openComputerUsePermissionsAsync(
  permissionId: ComputerUsePermissionId | undefined,
  pending: PendingSetupRequest
): Promise<ComputerUsePermissionSetupResult> {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      helperAppPath: null,
      permissionId,
      openedSettings: false,
      launchedHelper: false,
      permissions: [
        { id: 'accessibility', status: 'unsupported' },
        { id: 'screenshots', status: 'unsupported' }
      ],
      nextStep: null
    }
  }

  const helperAppPath = resolveMacOSComputerUseAppPath()
  if (!helperAppPath) {
    throw new RuntimeClientError('accessibility_error', 'Orca Computer Use.app was not found')
  }
  const status = await computerUsePermissionStatusGate.peek()
  if (status.helperUnavailableReason) {
    throw new RuntimeClientError('accessibility_error', status.helperUnavailableReason)
  }
  const nextStep = nextPermissionStep(status.permissions)

  if (!permissionId && !nextStep) {
    return {
      platform: process.platform,
      helperAppPath,
      permissionId,
      openedSettings: false,
      launchedHelper: false,
      permissions: status.permissions,
      nextStep
    }
  }

  if (pending.generation !== setupGeneration || setupShuttingDown) {
    return {
      platform: process.platform,
      helperAppPath,
      permissionId,
      openedSettings: false,
      launchedHelper: false,
      permissions: status.permissions,
      nextStep
    }
  }
  // A later Open for this key must queue behind this launch rather than coalesce into it.
  if (setupInFlight.get(pending.key)?.request === pending) {
    setupInFlight.delete(pending.key)
  }
  const helperArgs = permissionId ? ['--permission', permissionId] : ['--permissions']
  const launch = requestSetupHelperLaunch({ seq: pending.seq, helperAppPath, helperArgs })

  return {
    platform: process.platform,
    helperAppPath,
    permissionId,
    openedSettings: launch === 'launched' && permissionId !== undefined,
    launchedHelper: true,
    launchQueued: launch === 'queued',
    permissions: status.permissions,
    nextStep
  }
}

export function resetComputerUsePermissions(): Promise<ComputerUsePermissionResetResult> {
  return resetComputerUsePermissionsAsync()
}

async function resetComputerUsePermissionsAsync(): Promise<ComputerUsePermissionResetResult> {
  // Before any await, so a queued or preflighting Open can't slip a helper in during the reset.
  cancelQueuedSetupHelperLaunch()
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      helperAppPath: null,
      helperUnavailableReason: null,
      bundleId: null,
      permissions: [
        { id: 'accessibility', status: 'unsupported' },
        { id: 'screenshots', status: 'unsupported' }
      ]
    }
  }

  const helperAppPath = resolveMacOSComputerUseAppPath()
  if (!helperAppPath) {
    throw new RuntimeClientError('accessibility_error', 'Orca Computer Use.app was not found')
  }

  const unavailableReason = resolveComputerUseHelperUnavailableReason()
  if (unavailableReason) {
    throw new RuntimeClientError('accessibility_error', unavailableReason)
  }

  const bundleId = (await readMacosBundleId(helperAppPath)) ?? DEFAULT_COMPUTER_USE_BUNDLE_ID
  closeExistingPermissionHelpers()
  try {
    await resetTccPermission('Accessibility', bundleId)
    await resetTccPermission('ScreenCapture', bundleId)
  } finally {
    // Even a partial reset may have revoked grants; never serve the pre-reset snapshot again.
    computerUsePermissionStatusGate.invalidate()
  }

  return {
    ...(await computerUsePermissionStatusGate.read()),
    bundleId
  }
}

function closeExistingPermissionHelpers(): void {
  // Preserve concurrent status probes when replacing permission-setup helpers.
  const setupHelperPatterns = [
    'orca-computer-use-macos[[:space:]]+--permission([[:space:]]|$)',
    'orca-computer-use-macos[[:space:]]+--permissions([[:space:]]|$)'
  ]
  for (const pattern of setupHelperPatterns) {
    spawnSync('/usr/bin/pkill', ['-f', pattern], {
      stdio: 'ignore'
    })
  }
}

async function resetTccPermission(service: string, bundleId: string): Promise<void> {
  // TCC grants survive uninstall; explicitly reset the helper's stable bundle identity.
  const result = await resetMacosTccPermission(service, bundleId)
  if (!result.ok) {
    throw new RuntimeClientError(
      'accessibility_error',
      `Could not reset ${service}: ${result.detail}`
    )
  }
}

function nextPermissionStep(
  permissions: ComputerUsePermissionStatusResult['permissions']
): string | null {
  const missing = permissions.find((permission) => permission.status !== 'granted')
  if (!missing) {
    return null
  }
  return `Grant ${missing.id === 'accessibility' ? 'Accessibility' : 'Screen Recording'} to Orca Computer Use, then retry get-app-state.`
}
