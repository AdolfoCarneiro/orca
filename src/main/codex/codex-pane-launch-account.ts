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
  const { launchCodexHomePath: launch, systemCodexHomePath: system, target } = args
  const lane = getCodexSelectionLaneKey(target)
  const same = (left: string, right: string) =>
    normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
  const record = (owner: string | null, homeRoute: CodexPaneHomeRoute) => ({
    selectionKey: lane,
    accountId: args.pinnedByResume
      ? owner
      : getSelectedCodexAccountIdForTarget(args.settings, target),
    homeRoute
  })
  if (!launch || same(launch, system)) {
    return record(null, 'real-home')
  }
  const accounts = (args.settings.codexManagedAccounts ?? []).filter(
    (account) => getCodexSelectionLaneKey(getCodexSelectionTargetForAccount(account)) === lane
  )
  // Direct legacy addresses retain their no-IO compatibility, including duplicate first matches.
  const direct = accounts.find((account) => {
    if (
      (target.runtime === 'wsl' || basename(dirname(launch)) !== 'overlays') &&
      same(account.managedHomePath, launch)
    ) {
      return true
    }
    const wsl = target.runtime === 'wsl' ? parseWslUncPath(launch) : null
    return !!(
      wsl &&
      account.wslDistro?.trim() &&
      account.wslLinuxHomePath?.trim() &&
      wsl.distro.toLowerCase() === account.wslDistro.trim().toLowerCase() &&
      wsl.linuxPath === account.wslLinuxHomePath.trim()
    )
  })
  if (direct) {
    return record(direct.id, 'account-home')
  }
  if (target.runtime === 'wsl') {
    return args.pinnedByResume
      ? null
      : record(
          null,
          parseWslUncPath(launch)?.linuxPath.endsWith('/.codex') ? 'real-home' : 'wsl-home'
        )
  }
  let unknown = false
  const observe = <T>(read: () => T): T | undefined => {
    try {
      return read()
    } catch (error) {
      unknown = true
      console.warn('[codex-pane-account] Could not classify candidate:', error)
      return undefined
    }
  }
  const canonicalLaunch = observe(() => canonicalCodexHome(launch))
  const canonicalSystem = observe(() => canonicalCodexHome(system))
  const owners = new Set<string | null>()
  let real = false
  if (canonicalLaunch && canonicalSystem) {
    real = same(canonicalLaunch, canonicalSystem)
    if (real) {
      owners.add(null)
    }
  }
  const projections = new Map<string, string | undefined>()
  for (const account of accounts) {
    const root = dirname(dirname(account.managedHomePath))
    if (!projections.has(root)) {
      projections.set(
        root,
        canonicalLaunch && observe(() => codexLoginHome(canonicalLaunch, system, root))
      )
    }
    const projected = projections.get(root)
    const owned = observe(() => {
      const verdict = resolveHostCodexManagedHomeVerdict({
        candidatePath: account.managedHomePath,
        expectedAccountId: account.id,
        managedAccountsRoot: root,
        systemCodexHomePath: system
      })
      if (verdict.kind === 'indeterminate') {
        throw verdict.error
      }
      return verdict
    })
    if (projected && owned?.kind === 'owned' && same(projected, owned.homePath)) {
      owners.add(account.id)
    }
  }
  // System actors can have no managed candidate; their projection is independently observed.
  const systemProjection = canonicalLaunch && observe(() => codexLoginHome(canonicalLaunch, system))
  if (systemProjection && canonicalSystem && same(systemProjection, canonicalSystem)) {
    owners.add(null)
  }
  if (owners.size > 1) {
    return null
  }
  if (owners.size === 1) {
    const owner = [...owners][0]
    return record(owner, owner === null ? (real ? 'real-home' : 'shared-home') : 'account-home')
  }
  if (unknown || args.pinnedByResume) {
    return null
  }
  return record(null, 'shared-home')
}
