import { join } from 'node:path'
import { resolveHostCodexManagedHomeVerdict } from '../codex-accounts/host-codex-managed-home-ownership'
import {
  canonicalCodexHome,
  codexOverlayBelongsToFamily,
  type CodexHomePreparationOperation
} from './codex-launch-home'
import { reconcileCodexAccountHomeHook } from './codex-account-home-hook'
import type { CodexHomeLaunchContext } from '../ipc/pty/host-env/types'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { codexHookService } from './hook-service'
import { getDefaultWslDistro } from '../wsl'
import { isAgentStatusHooksEnabledForAgent } from '../agent-hooks/managed-agent-hook-controls'
import { reconcileCodexHooksForLaunch } from './codex-hook-reconcile'
import { grantCodexSandboxReadOnManagedHome } from './codex-windows-sandbox-read-grant'
import { getOrcaUserDataPath, getSystemCodexHomePath } from './codex-home-paths'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export function createCodexRuntimeHomeLaunchPreparation(deps: {
  getRuntimeHome: () => Pick<CodexRuntimeHomeService, 'prepareForCodexLaunchAsync'> | null
  getSettings: () => GlobalSettings | undefined
}) {
  return async (
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv,
    launchContext?: CodexHomeLaunchContext
  ): Promise<string | null> => {
    const runtimeHome = deps.getRuntimeHome()
    if (!runtimeHome) {
      throw new Error('Codex runtime home service is not initialized')
    }
    // Propagate home failures: null selects the system account, which could launch the wrong identity (STA-4422).
    const operation: CodexHomePreparationOperation = launchContext?.operation ?? {}
    const runtimeHomePath = await runtimeHome.prepareForCodexLaunchAsync(target, launchEnv, {
      conversationHome: launchContext?.conversationHome,
      operation,
      sessionId: launchContext?.sessionId,
      unavailableManagedHomePath: launchContext?.unavailableManagedHomePath
    })
    const launchesCodex = launchContext?.launchesCodex === true
    if (
      target?.runtime !== 'wsl' &&
      (runtimeHomePath === null ||
        normalizeRuntimePathForComparison(runtimeHomePath) ===
          normalizeRuntimePathForComparison(getSystemCodexHomePath()))
    ) {
      // Only terminal Codex launches wait for the scheduled hook reconciliation.
      if (launchesCodex) {
        await reconcileCodexHooksForLaunch()
      }
      return runtimeHomePath
    }
    if (runtimeHomePath !== null && target?.runtime !== 'wsl') {
      const prepared = operation.current
      const mayMaintain = (): boolean => {
        if (!prepared?.accountId) {
          return (
            prepared?.accountId === null &&
            (canonicalCodexHome(runtimeHomePath) === canonicalCodexHome(getSystemCodexHomePath()) ||
              codexOverlayBelongsToFamily(
                runtimeHomePath,
                process.platform === 'win32'
                  ? getSystemCodexHomePath()
                  : join(getOrcaUserDataPath(), 'codex-accounts', 'system')
              ))
          )
        }
        const account = deps
          .getSettings()
          ?.codexManagedAccounts.find((account) => account.id === prepared.accountId)
        if (!account || account.managedHomeRuntime === 'wsl') {
          return false
        }
        const verdict = resolveHostCodexManagedHomeVerdict({
          candidatePath: account.managedHomePath,
          managedAccountsRoot: join(getOrcaUserDataPath(), 'codex-accounts'),
          systemCodexHomePath: getSystemCodexHomePath(),
          expectedAccountId: account.id
        })
        return (
          verdict.kind === 'owned' &&
          verdict.homePath === prepared.loginHome &&
          (canonicalCodexHome(runtimeHomePath) === verdict.homePath ||
            codexOverlayBelongsToFamily(runtimeHomePath, prepared.family))
        )
      }
      try {
        if (!mayMaintain()) {
          return runtimeHomePath
        }
        await grantCodexSandboxReadOnManagedHome(runtimeHomePath, mayMaintain)
        if (mayMaintain()) {
          await reconcileCodexAccountHomeHook(
            runtimeHomePath,
            () => mayMaintain() && isAgentStatusHooksEnabledForAgent(deps.getSettings(), 'codex'),
            launchesCodex
          )
        }
      } catch (error) {
        console.warn('[codex-hook-service] failed to prepare account hooks before launch', error)
      }
      return runtimeHomePath
    }
    const hookTarget =
      target?.runtime === 'wsl'
        ? { runtime: 'wsl' as const, wslDistro: target.wslDistro?.trim() || getDefaultWslDistro() }
        : target
    const isHooksEnabled = (): boolean =>
      isAgentStatusHooksEnabledForAgent(deps.getSettings(), 'codex')
    const hooksEnabled = isHooksEnabled()
    try {
      const status = await codexHookService.prepareRuntimeHomeForLaunch(
        runtimeHomePath,
        hookTarget,
        isHooksEnabled,
        launchesCodex
      )
      if (status.state === 'error') {
        console.warn(
          `[codex-hook-service] failed to ${hooksEnabled ? 'refresh' : 'refresh user'} runtime hooks before launch`,
          status.detail
        )
      }
    } catch (error) {
      // Malformed hooks must not prevent Codex from starting.
      console.warn(
        `[codex-hook-service] failed to ${hooksEnabled ? 'refresh' : 'refresh user'} runtime hooks before launch`,
        error
      )
    }
    return runtimeHomePath
  }
}
