import {
  ResumePlanNotDispatchedError,
  RESUME_LAUNCH_NOT_DISPATCHED
} from '../../../../shared/agent-terminal-resume-outcome'
import { getPtyIpc } from '../pty-host-bindings'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import { attachOnlyViewOf, attachViewAfterHiddenStart } from '../pane/attach-only-view'

export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyStartupPromise } = deps

  ipcMain.handle('pty:spawn', async (_event, args: PtySpawnIpcArgs) => {
    const startupPromise = getLocalPtyStartupPromise(
      getConnectionExecutionHostId(args.connectionId)
    )
    if (startupPromise) {
      await startupPromise
    }
    if (attachOnlyViewOf(args) && args.sessionId && args.initiallyHidden !== true) {
      return attachViewAfterHiddenStart(
        args.sessionId,
        deps.transitionSpawnHiddenRendererPtyDeliveryState,
        () => runPtyIpcSpawn(deps, args)
      )
    }
    try {
      return await runPtyIpcSpawn(deps, args)
    } catch (error) {
      if (!(error instanceof ResumePlanNotDispatchedError)) {
        throw error
      }
      return {
        ok: false,
        error: {
          code: 'runtime_error',
          message: error.message,
          data: RESUME_LAUNCH_NOT_DISPATCHED
        }
      }
    }
  })
}
