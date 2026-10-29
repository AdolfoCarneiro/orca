import { spawn, spawnSync } from 'node:child_process'
import { RuntimeClientError } from './runtime-client-error'
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

// One setup-helper launch per 5s across every permission; the window is claimed synchronously.
const SETUP_HELPER_LAUNCH_WINDOW_MS = 5_000
let lastSetupLaunchAt = Number.NEGATIVE_INFINITY
let queuedSetupLaunch: { helperAppPath: string; helperArgs: string[] } | null = null
const setupInFlight = new Map<string, Promise<ComputerUsePermissionSetupResult>>()

export function openComputerUsePermissions(
  permissionId?: ComputerUsePermissionId
): Promise<ComputerUsePermissionSetupResult> {
  const key = permissionId ?? 'all'
  const existing = setupInFlight.get(key)
  if (existing) {
    return existing
  }
  const run = openComputerUsePermissionsAsync(permissionId).finally(() => setupInFlight.delete(key))
  setupInFlight.set(key, run)
  return run
}

// Launches now, or queues the latest request for when the window reopens; never drops a click.
function requestSetupHelperLaunch(
  helperAppPath: string,
  helperArgs: string[]
): 'launched' | 'queued' {
  const waitMs = lastSetupLaunchAt + SETUP_HELPER_LAUNCH_WINDOW_MS - Date.now()
  if (waitMs <= 0 && !queuedSetupLaunch) {
    launchSetupHelper(helperAppPath, helperArgs)
    return 'launched'
  }
  if (!queuedSetupLaunch) {
    const timer = setTimeout(
      () => {
        const queued = queuedSetupLaunch
        queuedSetupLaunch = null
        if (queued) {
          launchSetupHelper(queued.helperAppPath, queued.helperArgs)
        }
      },
      Math.max(0, waitMs)
    )
    timer.unref?.()
  }
  queuedSetupLaunch = { helperAppPath, helperArgs }
  return 'queued'
}

function launchSetupHelper(helperAppPath: string, helperArgs: string[]): void {
  lastSetupLaunchAt = Date.now()
  // Kill and relaunch so a repeated click always brings the helper back to the front.
  closeExistingPermissionHelpers()
  const helper = spawn('/usr/bin/open', ['-n', helperAppPath, '--args', ...helperArgs], {
    detached: true,
    stdio: 'ignore'
  })
  helper.unref()
}

async function openComputerUsePermissionsAsync(
  permissionId: ComputerUsePermissionId | undefined
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

  const helperArgs = permissionId ? ['--permission', permissionId] : ['--permissions']
  const launch = requestSetupHelperLaunch(helperAppPath, helperArgs)

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
