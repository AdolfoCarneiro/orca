export type ComputerUsePermissionId = 'accessibility' | 'screenshots'

export type ComputerUsePermissionStatus = 'granted' | 'not-granted' | 'unsupported'

export type ComputerUsePermissionState = {
  id: ComputerUsePermissionId
  status: ComputerUsePermissionStatus
}

export type ComputerUsePermissionStatusResult = {
  platform: NodeJS.Platform
  helperAppPath: string | null
  helperUnavailableReason: string | null
  permissions: ComputerUsePermissionState[]
}

export type ComputerUsePermissionSetupResult = {
  platform: NodeJS.Platform
  helperAppPath: string | null
  permissionId?: ComputerUsePermissionId
  openedSettings: boolean
  // True when a helper launched or is queued to launch within 5s; older clients only read this.
  launchedHelper: boolean
  launchQueued?: boolean
  permissions?: ComputerUsePermissionState[]
  nextStep?: string | null
}

export type ComputerUsePermissionResetResult = ComputerUsePermissionStatusResult & {
  bundleId: string | null
}
