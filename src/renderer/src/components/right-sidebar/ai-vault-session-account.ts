import { useEffect, useState } from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { isLegacyAgentSessionAccountHome } from '../../../../shared/agent-session-account-home'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ManagedDataAccountsState } from '../../../../shared/managed-account-types'
import { translate } from '@/i18n/i18n'
import { getCodexAccountDisplayLabel } from '@/lib/codex-account-display-label'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { subscribeRuntimeRpc } from '@/runtime/runtime-rpc-subscribe'
import {
  fetchProviderAccountsSnapshot,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import { useAppStore } from '../../store'

type SessionAccountSettings = Pick<GlobalSettings, 'claudeManagedAccounts' | 'codexManagedAccounts'>
type SessionAccounts = Partial<ProviderAccountsSnapshot> & { opencode?: ManagedDataAccountsState }
type SessionAccountSource = Pick<
  AiVaultSession,
  'agent' | 'executionHostId' | 'accountHome' | 'accountWslDistro'
>

export function resolveAiVaultSessionAccount(
  session: SessionAccountSource,
  settings: SessionAccountSettings | null,
  accounts: SessionAccounts | null
): string | null {
  if (session.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const home = session.accountHome
  if (home === null) {
    return translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')
  }
  if (!home) {
    return null
  }
  if (!isLegacyAgentSessionAccountHome(home)) {
    if (home.locator.kind === 'unmanaged') {
      return translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')
    }
    const profileId = home.locator.managedProfileId
    return accounts?.opencode?.accounts.find((account) => account.id === profileId)?.label ?? null
  }
  const sameHome = (path: string | null | undefined): boolean =>
    !!path &&
    normalizeRuntimePathForComparison(path) === normalizeRuntimePathForComparison(home.path)
  const sameRuntime = (
    runtime: 'host' | 'wsl' | undefined,
    distro: string | null | undefined
  ): boolean =>
    session.accountWslDistro
      ? runtime === 'wsl' && distro?.toLowerCase() === session.accountWslDistro.toLowerCase()
      : runtime !== 'wsl'

  if (session.agent === 'claude' && home.variable === 'CLAUDE_CONFIG_DIR') {
    if (!accounts?.claude || accounts.failedProviders?.includes('claude')) {
      return null
    }
    const roster = accounts.claude.accounts
    const current = roster.find(
      (account) =>
        sameRuntime(account.managedAuthRuntime, account.wslDistro) && sameHome(account.home)
    )
    if (current) {
      return current.email
    }
    const saved = settings?.claudeManagedAccounts.find(
      (account) =>
        sameRuntime(account.managedAuthRuntime, account.wslDistro) &&
        (sameHome(account.managedAuthPath) || sameHome(account.wslLinuxAuthPath))
    )
    if (!saved) {
      return null
    }
    const summary = roster.find((account) => account.id === saved.id)
    // The router may replace a legacy saved folder; only older summaries lack its actual home.
    return !summary || (summary.home && !sameHome(summary.home)) ? null : summary.email
  }
  if (session.agent === 'codex' && home.variable === 'CODEX_HOME') {
    const saved = settings?.codexManagedAccounts.find(
      (account) =>
        sameRuntime(account.managedHomeRuntime, account.wslDistro) &&
        (sameHome(account.managedHomePath) || sameHome(account.wslLinuxHomePath))
    )
    if (!saved) {
      return null
    }
    const roster = (accounts?.codex?.accounts ?? settings?.codexManagedAccounts ?? []).filter(
      (account) => sameRuntime(account.managedHomeRuntime, account.wslDistro)
    )
    return getCodexAccountDisplayLabel(
      roster.find((account) => account.id === saved.id) ?? saved,
      roster
    )
  }
  return null
}

export function useAiVaultSessionAccount(session: SessionAccountSource): string | null {
  const [accounts, setAccounts] = useState<SessionAccounts | null>(null)
  const agent = session.agent
  const dataAccount =
    !!session.accountHome &&
    !isLegacyAgentSessionAccountHome(session.accountHome) &&
    session.accountHome.locator.kind === 'managed'
  const needsAccounts =
    session.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    session.accountHome != null &&
    (agent === 'claude' || agent === 'codex' || dataAccount)
  const claudeSaved = useAppStore((state) =>
    needsAccounts && agent === 'claude' ? state.settings?.claudeManagedAccounts : undefined
  )
  const codexSaved = useAppStore((state) =>
    needsAccounts && agent === 'codex' ? state.settings?.codexManagedAccounts : undefined
  )

  useEffect(() => {
    if (!needsAccounts) {
      return
    }
    let cancelled = false
    let generation = 0
    let unsubscribe: (() => void) | undefined
    const load = (): void => {
      const attempt = ++generation
      const request = dataAccount
        ? callRuntimeRpc<SessionAccounts>({ kind: 'local' }, 'accounts.listData')
        : fetchProviderAccountsSnapshot({ kind: 'local' })
      void request.then(
        (snapshot) => {
          if (!cancelled && generation === attempt) {
            setAccounts(snapshot)
          }
        },
        () => {
          if (!cancelled && generation === attempt) {
            setAccounts(null)
          }
        }
      )
    }
    const lose = (): void => {
      generation += 1
      if (!cancelled) {
        setAccounts(null)
      }
    }
    if (dataAccount) {
      void subscribeRuntimeRpc({ kind: 'local' }, 'accounts.subscribe', null, {
        onEvent: (frame) => {
          if (!cancelled && typeof frame === 'object' && frame !== null && 'type' in frame) {
            if (frame.type === 'ready' || frame.type === 'snapshot') {
              load()
            } else if (frame.type === 'end') {
              lose()
            }
          }
        },
        onError: lose,
        onClose: lose
      }).then((handle) => {
        if (cancelled) {
          handle.unsubscribe()
        } else {
          unsubscribe = handle.unsubscribe
        }
      }, lose)
    } else {
      load()
    }
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [agent, dataAccount, needsAccounts, claudeSaved, codexSaved])

  return resolveAiVaultSessionAccount(
    session,
    { claudeManagedAccounts: claudeSaved ?? [], codexManagedAccounts: codexSaved ?? [] },
    accounts
  )
}
