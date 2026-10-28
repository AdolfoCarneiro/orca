import {
  agentSessionVisibleTabIndex,
  listVisibleAgentSessionIds,
  setAgentSessionTabVisibility,
  showAgentSessionTabs
} from './agent-session/agent-session-tab-table'
import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'
export abstract class AgentSessionRecordPublication {
  constructor(protected readonly transactions: AgentSessionStoreTransactions) {}
  abstract holdsRecords(): boolean
  private readonly deathEvidenceListeners = new Set<(sessionId: string) => void>()

  protected readonly firstRecordListeners = new Set<() => void>()

  /** Notify committed death evidence from every transition; listeners must not throw. */
  onDeathEvidence(listener: (sessionId: string) => void): () => void {
    this.deathEvidenceListeners.add(listener)
    return () => this.deathEvidenceListeners.delete(listener)
  }

  /** Notify first committed record; listeners must not throw. */
  onFirstRecord(listener: () => void): () => void {
    this.firstRecordListeners.add(listener)
    return () => this.firstRecordListeners.delete(listener)
  }

  /** Serialize draft mutations; publish to readers only after row commit. */
  protected transact = async <T>(
    apply: (draft: AgentSessionStoreState) => T,
    options?: { inMemoryWhenReadOnly?: boolean }
  ): Promise<T> => {
    let proven: string[] = []
    let heldBefore = true
    const result = await this.transactions.transact((draft) => {
      heldBefore = this.holdsRecords()
      if (this.deathEvidenceListeners.size === 0) {
        return apply(draft)
      }
      const before = new Map(
        [...draft.records].map(([id, record]) => [id, record.lease.deathEvidence])
      )
      const applied = apply(draft)
      proven = [...draft.records]
        .filter(([id, { lease }]) => lease.deathEvidence && lease.deathEvidence !== before.get(id))
        .map(([id]) => id)
      return applied
    }, options)
    for (const sessionId of proven) {
      this.deathEvidenceListeners.forEach((listener) => listener(sessionId))
    }
    if (!heldBefore && this.holdsRecords()) {
      this.firstRecordListeners.forEach((listener) => listener())
    }
    return result
  }

  protected get state(): AgentSessionStoreState {
    return this.transactions.state
  }

  listVisibleSessionIds = (): string[] => listVisibleAgentSessionIds(this.state)

  getVisibleSessionTabIndex = (): { present: boolean; sessionIds: string[] } =>
    agentSessionVisibleTabIndex(this.state)

  getSessionTabId = (sessionId: string): string | null =>
    this.state.sessionTabs?.tabIdFor(sessionId) ?? null

  setSessionTabVisibility(
    sessionId: string,
    visible: boolean,
    tabId?: string,
    check?: () => void
  ): Promise<void> {
    return this.transact((draft) => {
      check?.()
      return setAgentSessionTabVisibility(draft, sessionId, visible, tabId)
    })
  }

  setSwitchedSessionTabVisibility(
    sessionId: string,
    tabId: string,
    visible: boolean,
    admit: () => boolean
  ): Promise<boolean> {
    return this.transact((draft) => {
      if (
        (visible
          ? draft.sessionTabs?.tabIdFor(sessionId) !== undefined
          : draft.sessionTabs?.tabIdFor(sessionId) !== tabId) ||
        !admit()
      ) {
        return false
      }
      setAgentSessionTabVisibility(draft, sessionId, visible, tabId)
      return true
    })
  }

  showSessionTabs(sessionIds: readonly string[]): Promise<void> {
    return this.transact((draft) => showAgentSessionTabs(draft, sessionIds))
  }
}
