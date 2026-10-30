import { lstatSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { codexAccountOverlayHomes } from './codex-launch-home'
import { codexConversationStore } from './codex-conversation-store-path'
import { getOrcaUserDataPath, getSystemCodexHomePath } from './codex-home-paths'
import { resolveHostCodexManagedHomeVerdict } from '../codex-accounts/host-codex-managed-home-ownership'

/** Includes retired accounts and stores selected before a source-home change. */
export function getCodexAccountHomeSessionDirectories(): string[] {
  return discoverCodexStoreHomes(undefined, undefined, (path, error) =>
    console.warn('[codex-discovery] Could not read home:', path, error)
  ).flatMap((home) => {
    const sessions = join(home, 'sessions')
    try {
      // Only overlays deliberately redirect sessions; legacy homes cannot scan unrelated trees.
      return basename(dirname(home)) === 'overlays' || lstatSync(sessions).isDirectory()
        ? [sessions]
        : []
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        console.warn('[codex-discovery] Could not read sessions:', sessions, error)
      }
      return []
    }
  })
}

/** Removed accounts still own stores; settings are deliberately not the inventory. */
export function discoverCodexStoreHomes(
  accountsRoot = join(getOrcaUserDataPath(), 'codex-accounts'),
  systemHome = getSystemCodexHomePath(),
  onError?: (path: string, error: unknown) => void
): string[] {
  const homes: string[] = []
  const families = [systemHome]
  let accounts: string[] = []
  try {
    accounts = readdirSync(accountsRoot)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      if (!onError) {
        throw error
      }
      onError(accountsRoot, error)
    }
  }
  for (const id of accounts) {
    const home = join(accountsRoot, id, 'home')
    try {
      const verdict = resolveHostCodexManagedHomeVerdict({
        candidatePath: home,
        managedAccountsRoot: accountsRoot,
        systemCodexHomePath: systemHome,
        expectedAccountId: id
      })
      if (verdict.kind === 'indeterminate') {
        throw verdict.error
      }
      if (verdict.kind === 'owned') {
        homes.push(home)
      } else if (id !== 'system') {
        continue
      }
    } catch (error) {
      if (!onError) {
        throw error
      }
      onError(home, error)
      continue
    }
    families.push(join(accountsRoot, id))
  }
  for (const family of families) {
    for (const overlay of codexAccountOverlayHomes(family, onError)) {
      homes.push(overlay)
      try {
        homes.push(codexConversationStore(overlay))
      } catch (error) {
        if (!isDefinitiveAbsence(error)) {
          if (!onError) {
            throw error
          }
          onError(overlay, error)
        }
      }
    }
  }
  return [...new Set(homes)]
}
