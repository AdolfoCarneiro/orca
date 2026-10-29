import { randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { safeRemoveTree } from '../pty/overlay-mirror'
import { resolveHostCodexManagedHomeVerdict } from '../codex-accounts/host-codex-managed-home-ownership'
import {
  getOrcaUserDataPath,
  getSystemCodexHomePath,
  syncSystemCodexResourcesIntoManagedHome
} from './codex-home-paths'
import { initializeCodexOverlayConfigAtBirth } from './codex-config-mirror'
import { canonicalCodexHome, codexConversationStore } from './codex-conversation-store-path'

export { canonicalCodexHome, codexConversationStore }

export const CODEX_STORE_DIRECTORIES = [
  'sessions',
  'archived_sessions',
  'thread-writer-locks',
  '.tmp',
  'rollout-migrations'
] as const

function defaultAccountsRoot(): string {
  return join(getOrcaUserDataPath(), 'codex-accounts')
}

function samePath(left: string, right: string): boolean {
  return canonicalCodexHome(left) === canonicalCodexHome(right)
}

/** Projection is read-only; only a current owned login grants maintenance authority. */
export function codexLoginHome(
  home: string,
  systemHome = getSystemCodexHomePath(),
  accountsRoot = defaultAccountsRoot()
): string {
  if (!/^[a-f0-9]{32}$/.test(basename(home)) || basename(dirname(home)) !== 'overlays') {
    return home
  }
  const family = dirname(dirname(home))
  if (!codexOverlayBelongsToFamily(home, family)) {
    return home
  }
  if (samePath(family, systemHome) || samePath(family, join(accountsRoot, 'system'))) {
    return systemHome
  }
  const login = join(family, 'home')
  const verdict = resolveHostCodexManagedHomeVerdict({
    candidatePath: login,
    managedAccountsRoot: accountsRoot,
    systemCodexHomePath: systemHome,
    expectedAccountId: basename(family)
  })
  if (verdict.kind === 'indeterminate') {
    throw verdict.error
  }
  return verdict.kind === 'owned' ? verdict.homePath : home
}

export function codexOverlayBelongsToFamily(home: string, accountDirectory: string): boolean {
  const root = join(canonicalCodexHome(accountDirectory), 'overlays')
  const expected = join(root, basename(home))
  try {
    return (
      /^[a-f0-9]{32}$/.test(basename(home)) &&
      lstatSync(accountDirectory).isDirectory() &&
      canonicalCodexHome(dirname(dirname(home))) === canonicalCodexHome(accountDirectory) &&
      lstatSync(root).isDirectory() &&
      canonicalCodexHome(root) === root &&
      lstatSync(home).isDirectory() &&
      canonicalCodexHome(home) === expected &&
      Boolean(readlinkSync(join(home, 'sessions')))
    )
  } catch (error) {
    if (
      !isDefinitiveAbsence(error) &&
      !(error instanceof Error && 'code' in error && error.code === 'EINVAL')
    ) {
      throw error
    }
    return false
  }
}

export function codexAccountOverlayHomes(accountDirectory: string): string[] {
  const root = join(accountDirectory, 'overlays')
  try {
    if (
      !lstatSync(root).isDirectory() ||
      canonicalCodexHome(root) !== join(canonicalCodexHome(accountDirectory), 'overlays')
    ) {
      return []
    }
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name))
      .map((entry) => join(root, entry.name))
      .filter((home) => codexOverlayBelongsToFamily(home, accountDirectory))
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    return []
  }
}

/** Removed accounts still own stores; settings are deliberately not the inventory. */
export function discoverCodexStoreHomes(
  accountsRoot = defaultAccountsRoot(),
  systemHome = getSystemCodexHomePath()
): string[] {
  const homes: string[] = []
  const families = [systemHome]
  let accounts: string[] = []
  try {
    accounts = readdirSync(accountsRoot)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  for (const id of accounts) {
    const home = join(accountsRoot, id, 'home')
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
    families.push(join(accountsRoot, id))
  }
  for (const family of families) {
    for (const overlay of codexAccountOverlayHomes(family)) {
      homes.push(overlay)
      try {
        homes.push(codexConversationStore(overlay))
      } catch (error) {
        if (!isDefinitiveAbsence(error)) {
          throw error
        }
      }
    }
  }
  return [...new Set(homes)]
}

export type CodexPreparedHome = {
  selectionKey: string
  accountId: string | null | undefined
  loginHome: string
  store: string
  family: string
  disposition: 'direct' | 'layered'
  home: string | undefined
}

/** Owned by one acquisition, never by an account or a surviving process. */
export type CodexHomePreparationOperation = { current?: CodexPreparedHome }

export type CodexLaunchHomeOptions = {
  /** Null selects known System. Managed homes are ownership-checked by the caller. */
  selectedAccount: { homePath: string; id?: string } | null
  conversationHome?: string | null
  storeHome?: string
  systemHome?: string
  accountsRoot?: string
  selectionKey?: string
  operation?: CodexHomePreparationOperation
  /** Read a supplied actual actor exactly, or the logical selected login; never construct. */
  readOnly?: boolean
}

export function resolveCodexLaunchHome(options: CodexLaunchHomeOptions): string | undefined {
  const systemHome = options.systemHome ?? getSystemCodexHomePath()
  const loginHome = options.selectedAccount?.homePath ?? systemHome
  if (options.readOnly) {
    return options.conversationHome && basename(dirname(options.conversationHome)) === 'overlays'
      ? options.conversationHome
      : options.selectedAccount
        ? loginHome
        : undefined
  }
  const store = codexConversationStore(options.conversationHome ?? options.storeHome ?? loginHome)
  const family = options.selectedAccount
    ? dirname(loginHome)
    : process.platform === 'win32'
      ? systemHome
      : join(options.accountsRoot ?? defaultAccountsRoot(), 'system')
  const direct =
    (!options.selectedAccount && !existsSync(join(systemHome, 'auth.json'))) ||
    store === canonicalCodexHome(loginHome)
  const roles = {
    selectionKey: options.selectionKey ?? 'host',
    accountId: options.selectedAccount ? options.selectedAccount.id : null,
    loginHome: canonicalCodexHome(loginHome),
    store,
    family,
    disposition: direct ? ('direct' as const) : ('layered' as const)
  }
  const previous = options.operation?.current
  if (
    previous &&
    previous.selectionKey === roles.selectionKey &&
    previous.accountId === roles.accountId &&
    previous.loginHome === roles.loginHome &&
    samePath(previous.store, roles.store) &&
    samePath(previous.family, roles.family) &&
    previous.disposition === roles.disposition
  ) {
    return previous.home
  }
  // Replacement drops the whole old preparation, even if construction subsequently fails.
  if (options.operation) {
    options.operation.current = undefined
  }
  const home = direct
    ? options.selectedAccount
      ? loginHome
      : undefined
    : materializeCodexOverlay(family, store, loginHome, systemHome)
  if (options.operation) {
    options.operation.current = { ...roles, home }
  }
  return home
}

function linkLoginAtBirth(home: string, loginHome: string): void {
  writeFileSync(join(loginHome, 'auth.lock'), '', { flag: 'a', mode: 0o600 })
  for (const entry of ['auth.json', 'auth.lock']) {
    const source = join(loginHome, entry)
    const target = join(home, entry)
    if (process.platform === 'win32') {
      if (existsSync(source)) {
        linkSync(source, target)
      }
    } else {
      symlinkSync(source, target, 'file')
    }
  }
}

function materializeCodexOverlay(
  family: string,
  store: string,
  loginHome: string,
  systemHome: string
): string {
  mkdirSync(family, { recursive: true })
  if (!lstatSync(family).isDirectory()) {
    throw new Error('Codex actor family is redirected')
  }
  const root = join(family, 'overlays')
  mkdirSync(root, { recursive: true })
  if (
    !lstatSync(root).isDirectory() ||
    canonicalCodexHome(root) !== join(canonicalCodexHome(family), 'overlays')
  ) {
    throw new Error('Codex actor root is redirected')
  }
  const overlay = join(canonicalCodexHome(root), randomUUID().replaceAll('-', ''))
  const staging = `${overlay}.creating`
  // The exclusive staging name reserves this actor across concurrent constructors.
  mkdirSync(staging)
  try {
    try {
      lstatSync(overlay)
      throw new Error('Codex actor already exists')
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
    }
    for (const entry of CODEX_STORE_DIRECTORIES) {
      mkdirSync(join(store, entry), { recursive: true })
      symlinkSync(
        join(store, entry),
        join(staging, entry),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    }
    linkLoginAtBirth(staging, loginHome)
    syncSystemCodexResourcesIntoManagedHome(staging)
    initializeCodexOverlayConfigAtBirth({
      runtimeHomePath: staging,
      effectiveHomePath: overlay,
      systemHomePath: systemHome
    })
    renameSync(staging, overlay)
    return overlay
  } catch (error) {
    safeRemoveTree(staging)
    throw error
  }
}
