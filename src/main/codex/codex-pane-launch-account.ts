import { resolveHostCodexManagedHomeVerdict } from '../codex-accounts/host-codex-managed-home-ownership'
import { canonicalCodexHome, codexLoginHome } from './codex-launch-home'
import { basename, dirname } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  getCodexSelectionLaneKey,
  getCodexSelectionTargetForAccount,
  getSelectedCodexAccountIdForTarget,
  type CodexAccountSelectionTarget
} from '../codex-accounts/runtime-selection'
import type { CodexPaneAccountRecord, CodexPaneHomeRoute } from './codex-pane-account-registry'

type CodexPaneLaunchAccountSettings = Pick<
  GlobalSettings,
  'activeCodexManagedAccountId' | 'activeCodexManagedAccountIdsByRuntime' | 'codexManagedAccounts'
>

// Resumes pin CODEX_HOME independently of selection; restart prompts must name the actual account.
export function resolveCodexPaneLaunchAccount(args: {
  pinnedByResume: boolean
  launchCodexHomePath: string | null
  systemCodexHomePath: string
  settings: CodexPaneLaunchAccountSettings
  target: CodexAccountSelectionTarget
}): CodexPaneAccountRecord | null {
  try {
    return classifyCodexPaneLaunchAccount(args)
  } catch (error) {
    console.warn('[codex-pane-account] Could not classify spawned Codex home:', error)
    return null
  }
}

function classifyCodexPaneLaunchAccount(
  args: Parameters<typeof resolveCodexPaneLaunchAccount>[0]
): CodexPaneAccountRecord | null {
  const accountId = args.pinnedByResume
    ? resolveCodexHomeOwnerAccountId(args)
    : getSelectedCodexAccountIdForTarget(args.settings, args.target)
  if (accountId === undefined) {
    return null
  }
  return {
    selectionKey: getCodexSelectionLaneKey(args.target),
    accountId,
    homeRoute: resolveCodexPaneHomeRoute(args)
  }
}

function resolveCodexPaneHomeRoute(args: {
  launchCodexHomePath: string | null
  systemCodexHomePath: string
  settings: CodexPaneLaunchAccountSettings
  target: CodexAccountSelectionTarget
}): CodexPaneHomeRoute {
  if (
    !args.launchCodexHomePath ||
    normalizeRuntimePathForComparison(args.launchCodexHomePath) ===
      normalizeRuntimePathForComparison(args.systemCodexHomePath)
  ) {
    return 'real-home'
  }
  if (
    args.target.runtime !== 'wsl' &&
    normalizeRuntimePathForComparison(canonicalCodexHome(args.launchCodexHomePath)) ===
      normalizeRuntimePathForComparison(canonicalCodexHome(args.systemCodexHomePath))
  ) {
    return 'real-home'
  }
  const launchHomePath = args.launchCodexHomePath
  const accountOwnsHome = args.settings.codexManagedAccounts?.some((account) =>
    accountOwnsCodexHome(account, args.target, launchHomePath, args.systemCodexHomePath)
  )
  if (accountOwnsHome) {
    return 'account-home'
  }
  if (args.target.runtime === 'wsl') {
    return parseWslUncPath(args.launchCodexHomePath)?.linuxPath.endsWith('/.codex')
      ? 'real-home'
      : 'wsl-home'
  }
  return 'shared-home'
}

/** undefined when no account owns the home; null means the system-default account. */
function resolveCodexHomeOwnerAccountId(args: {
  launchCodexHomePath: string | null
  systemCodexHomePath: string
  settings: CodexPaneLaunchAccountSettings
  target: CodexAccountSelectionTarget
}): string | null | undefined {
  // Without injected CODEX_HOME, Codex reads the user's own home.
  if (!args.launchCodexHomePath) {
    return null
  }
  if (
    normalizeRuntimePathForComparison(
      args.target.runtime === 'wsl'
        ? args.launchCodexHomePath
        : canonicalCodexHome(codexLoginHome(args.launchCodexHomePath, args.systemCodexHomePath))
    ) ===
    normalizeRuntimePathForComparison(
      args.target.runtime === 'wsl'
        ? args.systemCodexHomePath
        : canonicalCodexHome(args.systemCodexHomePath)
    )
  ) {
    return null
  }
  const launchHomePath = args.launchCodexHomePath
  const owner = args.settings.codexManagedAccounts?.find((account) =>
    accountOwnsCodexHome(account, args.target, launchHomePath, args.systemCodexHomePath)
  )
  // Unknown owners cannot produce safe restart prompts; guessing could block terminal input.
  return owner ? owner.id : undefined
}

function accountOwnsCodexHome(
  account: NonNullable<CodexPaneLaunchAccountSettings['codexManagedAccounts']>[number],
  target: CodexAccountSelectionTarget,
  launchHomePath: string,
  systemCodexHomePath: string
): boolean {
  // Host and per-distro WSL selection lanes must not claim each other's homes.
  if (
    getCodexSelectionLaneKey(getCodexSelectionTargetForAccount(account)) !==
    getCodexSelectionLaneKey(target)
  ) {
    return false
  }
  if (
    (target.runtime === 'wsl' || basename(dirname(launchHomePath)) !== 'overlays') &&
    normalizeRuntimePathForComparison(account.managedHomePath) ===
      normalizeRuntimePathForComparison(launchHomePath)
  ) {
    return true
  }
  if (target.runtime !== 'wsl') {
    const root = dirname(dirname(account.managedHomePath))
    const projected = codexLoginHome(canonicalCodexHome(launchHomePath), systemCodexHomePath, root)
    const owned = resolveHostCodexManagedHomeVerdict({
      candidatePath: account.managedHomePath,
      expectedAccountId: account.id,
      managedAccountsRoot: root,
      systemCodexHomePath
    })
    if (owned.kind === 'indeterminate') {
      throw owned.error
    }
    return (
      owned.kind === 'owned' &&
      normalizeRuntimePathForComparison(canonicalCodexHome(projected)) ===
        normalizeRuntimePathForComparison(owned.homePath)
    )
  }
  const launchWslHome = target.runtime === 'wsl' ? parseWslUncPath(launchHomePath) : null
  const accountDistro = account.wslDistro?.trim()
  const accountLinuxHome = account.wslLinuxHomePath?.trim()
  return Boolean(
    launchWslHome &&
    accountDistro &&
    accountLinuxHome &&
    launchWslHome.distro.toLowerCase() === accountDistro.toLowerCase() &&
    launchWslHome.linuxPath === accountLinuxHome
  )
}
