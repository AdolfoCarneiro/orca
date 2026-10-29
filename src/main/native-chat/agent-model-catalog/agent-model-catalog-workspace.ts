import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import type {
  AgentModelCatalogContext,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { retainedAgentModelCatalogModels } from './agent-model-catalog-entry'
import type {
  AgentModelCatalogLiveListing,
  AgentModelCatalogStore
} from './agent-model-catalog-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import type { AgentModelCatalogConfiguredChoice } from './agent-model-catalog-entry'

export type AgentModelCatalogRecord = Pick<
  AgentSessionRecord,
  'sessionId' | 'provider' | 'providerHandleChain' | 'accountHome' | 'location' | 'launchDirectory'
>

export type AgentModelCatalogWorkspaceDeps = {
  store: AgentModelCatalogStore
  /** Project-scoped catalogs require a folder and cannot be prewarmed. */
  listsInChatFolder?: ReadonlySet<string>
  recordWorkspacePath?: (record: AgentModelCatalogRecord) => Promise<string | null>
  /** Account-home config is already covered by discovery; only workspace layers can override it. */
  workspaceMayOverrideDefaultModel?: (input: {
    agent: string
    workspacePath: string
    accountHomePath: string | null
  }) => Promise<boolean>
}

export async function workspaceKeepsListedDefault(
  deps: AgentModelCatalogWorkspaceDeps,
  agent: string,
  workspacePath: string | null | undefined,
  accountHomePath: string | null
): Promise<boolean> {
  if (workspacePath === undefined) {
    return true
  }
  if (workspacePath === null || !deps.workspaceMayOverrideDefaultModel) {
    return false
  }
  try {
    return !(await deps.workspaceMayOverrideDefaultModel({ agent, workspacePath, accountHomePath }))
  } catch {
    return false
  }
}

/** null means the host cannot inspect this session's workspace. */
export async function sessionWorkspacePath(
  deps: AgentModelCatalogWorkspaceDeps,
  record: AgentModelCatalogRecord
): Promise<string | null> {
  if (!isNativeLocalLocation(record.location) || !deps.recordWorkspacePath) {
    return null
  }
  return deps.recordWorkspacePath(record).catch(() => null)
}

/** Prefer the named workspace, then the session folder; undefined uses account scope. */
export async function catalogFolder(
  deps: AgentModelCatalogWorkspaceDeps,
  agent: string,
  workspacePath: string | null | undefined,
  session: AgentModelCatalogRecord | undefined
): Promise<string | undefined> {
  if (!deps.listsInChatFolder?.has(agent)) {
    return undefined
  }
  const folder =
    workspacePath === undefined && session
      ? await sessionWorkspacePath(deps, session)
      : workspacePath
  return folder ?? undefined
}

/** Learn account defaults only without workspace overrides; null resolution retires stale facts. */
export async function recordConfiguredDefault(
  deps: AgentModelCatalogWorkspaceDeps & {
    getRecord: (id: string) => AgentSessionRecord | undefined
  },
  record: AgentSessionRecord,
  fingerprint: string,
  choice: AgentModelCatalogConfiguredChoice | null,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const accountHome = record.accountHome
  if (!isCurrent() || !deps.workspaceMayOverrideDefaultModel) {
    return
  }
  const workspacePath = await sessionWorkspacePath(deps, record)
  if (
    !isCurrent() ||
    !workspacePath ||
    (await deps.workspaceMayOverrideDefaultModel({
      agent: record.provider,
      workspacePath,
      accountHomePath: isLegacyAgentSessionAccountHome(accountHome) ? accountHome.path : null
    }))
  ) {
    return
  }
  if (
    !isCurrent() ||
    deps.getRecord(record.sessionId)?.lease.runtimeFence !== record.lease.runtimeFence
  ) {
    return
  }
  deps.store.recordConfiguredDefault(fingerprint, choice)
}

export function createAgentModelCatalogLiveListingRecorder(
  deps: Parameters<typeof recordConfiguredDefault>[0],
  recordingDefaults: Map<string, Promise<void>>
) {
  return (
    record: AgentSessionRecord,
    listing: AgentModelCatalogLiveListing,
    fingerprint: string,
    isCurrent: () => boolean = () => true
  ): void => {
    if (!isCurrent()) {
      return
    }
    const { configuredDefault, ...listed } = listing
    const saved = deps.store.recordSuccess(
      fingerprint,
      record.provider,
      { ...listed, origin: 'live-session' },
      'live'
    )
    if (saved && configuredDefault !== undefined) {
      // Preserve report order when learning configured defaults.
      const recording = (recordingDefaults.get(fingerprint) ?? Promise.resolve())
        .then(() =>
          recordConfiguredDefault(deps, record, fingerprint, configuredDefault, isCurrent)
        )
        .catch(() => {})
        .then(() => {
          if (recordingDefaults.get(fingerprint) === recording) {
            recordingDefaults.delete(fingerprint)
          }
        })
      recordingDefaults.set(fingerprint, recording)
    }
  }
}

export function createAgentModelCatalogRecordAccess(
  deps: AgentModelCatalogServiceDeps,
  signal: AbortSignal,
  sessionKeys: Map<string, { fingerprint: string; context?: AgentModelCatalogContext }>,
  liveWrites: Map<string, Promise<void>>,
  saveLiveListing: ReturnType<typeof createAgentModelCatalogLiveListingRecorder>
) {
  const capture = (record: AgentModelCatalogRecord, expected?: AgentModelCatalogContext) => {
    const context = expected ?? deps.readCatalogContext?.(record)
    const fence = deps.getRecord(record.sessionId)?.lease.runtimeFence
    return {
      context,
      record: context?.accountHome ? { ...record, accountHome: context.accountHome } : record,
      current: () =>
        !context ||
        (!signal.aborted &&
          !!context.accountHome &&
          context.isCurrent() &&
          deps.drivesRecord(record) &&
          deps.getRecord(record.sessionId)?.provider === record.provider &&
          deps.getRecord(record.sessionId)?.location.executionHostId ===
            record.location.executionHostId &&
          deps.getRecord(record.sessionId)?.location.wslDistro === record.location.wslDistro &&
          deps.getRecord(record.sessionId)?.location.workspaceId === record.location.workspaceId &&
          fence === context.fence &&
          deps.getRecord(record.sessionId)?.lease.runtimeFence === context.fence &&
          (!deps.readCatalogContext || deps.readCatalogContext(record) === context))
    }
  }
  const sessionCatalogKey = async (record: AgentModelCatalogRecord): Promise<string> =>
    agentModelCatalogFingerprintForRecord(
      record,
      await catalogFolder(deps, record.provider, undefined, record)
    )
  const association = (sessionId: string, expected?: AgentModelCatalogContext) => {
    const key = sessionKeys.get(sessionId)
    if (!key) {
      return undefined
    }
    const record = deps.getConversation(sessionId)
    const current = record ? deps.readCatalogContext?.(record) : undefined
    if (
      key.context !== (expected ?? current) ||
      (key.context && (!record || !capture(record, key.context).current()))
    ) {
      if (sessionKeys.get(sessionId) === key) {
        sessionKeys.delete(sessionId)
      }
      return undefined
    }
    return key.fingerprint
  }
  return {
    capture,
    association,
    sessionCatalogKey,
    providerStarted(record: AgentSessionRecord) {
      const captured = capture(record)
      if (!captured.current()) {
        return
      }
      record = { ...record, accountHome: captured.record.accountHome }
      const key = association(record.sessionId)
      if (key) {
        deps.store.expireFailure(key)
      }
      if (!deps.listsInChatFolder?.has(record.provider)) {
        deps.store.expireFailure(agentModelCatalogFingerprintForRecord(record))
        return
      }
      void sessionCatalogKey(record)
        .then((fingerprint) => {
          if (
            captured.current() &&
            deps.getRecord(record.sessionId)?.lease.runtimeFence === record.lease.runtimeFence
          ) {
            deps.store.expireFailure(fingerprint)
          }
        })
        .catch(() => {})
    },
    recordLiveListing(sessionId: string, listing: AgentModelCatalogLiveListing) {
      const original = deps.getRecord(sessionId)
      const captured = original ? capture(original) : undefined
      const record =
        original && captured ? { ...original, accountHome: captured.record.accountHome } : undefined
      if (
        !captured?.current() ||
        !record ||
        !deps.drivesRecord(record) ||
        independentAgentModelCatalog(record.provider)
      ) {
        return
      }
      if (!deps.listsInChatFolder?.has(record.provider)) {
        saveLiveListing(
          record,
          listing,
          agentModelCatalogFingerprintForRecord(record),
          captured.current
        )
        return
      }
      // Serialize reports so a slow folder lookup cannot overwrite a newer listing.
      const writing = (liveWrites.get(sessionId) ?? Promise.resolve())
        .then(async () => {
          const fingerprint = await sessionCatalogKey(record)
          if (
            captured.current() &&
            deps.getRecord(sessionId)?.lease.runtimeFence === record.lease.runtimeFence
          ) {
            saveLiveListing(record, listing, fingerprint, captured.current)
          }
        })
        .catch((error: unknown) => {
          console.warn('[agent-model-catalog] could not save a chat model list:', error)
        })
        .finally(() => {
          if (liveWrites.get(sessionId) === writing) {
            liveWrites.delete(sessionId)
          }
        })
      liveWrites.set(sessionId, writing)
    },
    async retainedLiveModelIds(sessionId: string, listing: AgentModelCatalogLiveListing) {
      const record = deps.getConversation(sessionId)
      const captured = record ? capture(record) : undefined
      const entry =
        record && captured?.current() && deps.drivesRecord(record)
          ? deps.store.get(await sessionCatalogKey(captured.record))
          : undefined
      return captured && !captured.current()
        ? []
        : retainedAgentModelCatalogModels(entry, listing).map((model) => model.id)
    }
  }
}
