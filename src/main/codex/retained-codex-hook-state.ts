import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import {
  canonicalCodexHome,
  codexAccountOverlayHomes,
  codexOverlayBelongsToFamily
} from './codex-launch-home'
import { getCodexPaneAccount, getObservedCodexPaneHome } from './codex-pane-account-registry'
import { reconcileCodexAccountHomeHook } from './codex-account-home-hook'

export type RetainedCodexHookTarget = { homePath: string; isCurrent: () => boolean }

/** Inventory is not authority: every write rechecks the current owner and existing target. */
export function collectRetainedCodexHookTargets(args: {
  systemHome: string
  accountsRoot: string
  legacyHome: string
  getSettings: () => GlobalSettings
  resolveTrustedHome: (account: CodexManagedAccount) => string | null
  ptyIds: readonly string[]
}): RetainedCodexHookTarget[] {
  let accounts = args.getSettings().codexManagedAccounts
  let byId = new Map(accounts.map((account) => [account.id, account]))
  const currentAccount = (id: string) => {
    const next = args.getSettings().codexManagedAccounts
    if (next !== accounts) {
      accounts = next
      byId = new Map(next.map((account) => [account.id, account]))
    }
    return byId.get(id)
  }
  const homes = new Map<string, RetainedCodexHookTarget>()
  const addFamily = (login: string, family: string, owner: () => boolean) => {
    const add = (homePath: string) => {
      const isCurrent = () => {
        if (!owner()) {
          return false
        }
        try {
          return (
            lstatSync(homePath).isDirectory() &&
            (canonicalCodexHome(homePath) === canonicalCodexHome(login) ||
              codexOverlayBelongsToFamily(homePath, family))
          )
        } catch (error) {
          if (isDefinitiveAbsence(error)) {
            return false
          }
          throw error
        }
      }
      if (isCurrent()) {
        homes.set(canonicalCodexHome(homePath), { homePath, isCurrent })
      }
    }
    add(login)
    for (const actor of codexAccountOverlayHomes(family)) {
      add(actor)
    }
  }
  addFamily(args.systemHome, args.systemHome, () => true)
  if (process.platform !== 'win32') {
    addFamily(args.systemHome, join(args.accountsRoot, 'system'), () => true)
  }
  for (const account of accounts) {
    if (account.managedHomeRuntime === 'wsl') {
      continue
    }
    const login = args.resolveTrustedHome(account)
    if (!login) {
      continue
    }
    const owner = () => {
      const current = currentAccount(account.id)
      return (
        current !== undefined &&
        current.managedHomeRuntime !== 'wsl' &&
        args.resolveTrustedHome(current) !== null &&
        canonicalCodexHome(current.managedHomePath) === canonicalCodexHome(login)
      )
    }
    addFamily(login, dirname(login), owner)
  }
  // Exact observations supplement the same current-authorized families; they grant no new root.
  if (
    args.ptyIds.some((id) => {
      const record = getCodexPaneAccount(id)
      return (
        record?.selectionKey === 'host' && (!record.homeRoute || record.homeRoute === 'shared-home')
      )
    })
  ) {
    addFamily(args.legacyHome, dirname(args.legacyHome), () => true)
  }
  for (const id of args.ptyIds) {
    const observed = getObservedCodexPaneHome(id)
    if (observed && homes.has(canonicalCodexHome(observed.actualHome))) {
      const target = homes.get(canonicalCodexHome(observed.actualHome))!
      homes.set(canonicalCodexHome(observed.actualHome), {
        ...target,
        homePath: observed.actualHome
      })
    }
  }
  return [...homes.values()]
}

/** Promotion-free maintenance never creates an unused actor or copies auth/config into it. */
export async function reconcileRetainedCodexHookHomes(args: {
  targets: readonly RetainedCodexHookTarget[]
  isEnabled: () => boolean
  isCurrent?: () => boolean
}): Promise<boolean> {
  let settled = true
  for (const target of args.targets) {
    try {
      const isCurrent = () => (args.isCurrent?.() ?? true) && target.isCurrent()
      if (!isCurrent()) {
        continue
      }
      const result = await reconcileCodexAccountHomeHook(
        target.homePath,
        args.isEnabled,
        false,
        isCurrent
      )
      if (result === 'unavailable' && target.isCurrent()) {
        settled = false
      }
    } catch (error) {
      settled = false
      console.warn('[codex-hook-service] retained Codex home reconcile failed:', error)
    }
  }
  return settled
}
