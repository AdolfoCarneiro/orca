import { app, ipcMain } from 'electron'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionResetResult,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'
import { computerUsePermissionStatusGate } from '../computer/macos-computer-use-permission-status-gate'

export function registerComputerUsePermissionHandlers(): void {
  // A queued setup helper must not pop up while Orca is shutting down.
  app.on('will-quit', () => {
    void import('../computer/macos-computer-use-permissions').then((permissions) =>
      permissions.cancelQueuedSetupHelperLaunch()
    )
  })
  ipcMain.handle(
    'computerUsePermissions:openSetup',
    async (
      _event,
      args?: { id?: ComputerUsePermissionId }
    ): Promise<ComputerUsePermissionSetupResult> => {
      const { openComputerUsePermissions } =
        await import('../computer/macos-computer-use-permissions')
      return openComputerUsePermissions(args?.id)
    }
  )
  ipcMain.handle(
    'computerUsePermissions:getStatus',
    (): Promise<ComputerUsePermissionStatusResult> => computerUsePermissionStatusGate.read()
  )
  ipcMain.handle(
    'computerUsePermissions:reset',
    async (): Promise<ComputerUsePermissionResetResult> => {
      const { resetComputerUsePermissions } =
        await import('../computer/macos-computer-use-permissions')
      return resetComputerUsePermissions()
    }
  )
}
