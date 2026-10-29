import '../../orca-runtime-test-mocks.spec'
import { vi } from 'vitest'
import { store, TEST_WORKTREE_ID } from '../../orca-runtime-test-fixtures.spec'
import type { TerminalIdentitySource } from '../identity/terminal-identity-source'
import type { CrewRuntimeReaders } from '../../orchestration/crew/crew-runtime-watch'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type {
  OrchestrationCompatibilitySshTerminal,
  TerminalHandleRecord
} from '../../runtime-terminal-contracts'
import type { PtyIncarnationHandleRecord } from '../../orca-runtime-core'
import type { CrewChanges } from '../../orchestration/crew/crew-changes'
import type { RuntimeTerminalWaiterRegistry } from '../wait/terminal-waiter-registry'
import type { LegacyWorkerTerminalRecoveryCandidate } from '../../orchestration/orchestration-legacy-worker-terminal-recovery'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { TerminalIdentityReadContext } from './terminal-identity-read-context'

export const LEAF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const COLD = 'cold:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const PANE = `tab-original:${LEAF}`

type Owner = {
  source: TerminalIdentitySource
  crewReaders: CrewRuntimeReaders
  getLeavesForPty: (id: string) => readonly RuntimeLeafRecord[]
  rollbackLegacy: (candidate: LegacyWorkerTerminalRecoveryCandidate) => void
  markUnavailable: (windowId: number) => void
  terminalWaiters: RuntimeTerminalWaiterRegistry
  crewChanges: CrewChanges
  orchestrationCompatibilitySshTerminals: Map<string, OrchestrationCompatibilitySshTerminal>
  getOrchestrationCompatibilitySshTerminal: (
    handle: string,
    context?: TerminalIdentityReadContext
  ) => OrchestrationCompatibilitySshTerminal | undefined
  runtimeId: string
  rendererGraphEpoch: number
  handles: ReadonlyMap<string, TerminalHandleRecord>
  handleByPtyId: ReadonlyMap<string, string>
  handleByLeafKey: ReadonlyMap<string, string>
  handleByPtyIncarnation: ReadonlyMap<string, PtyIncarnationHandleRecord>
  syntheticTerminalHandles: ReadonlySet<string>
  leaves: ReadonlyMap<string, RuntimeLeafRecord>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  recordPtyWorktree: (
    id: string,
    worktree: string,
    state?: Partial<RuntimePtyWorktreeRecord>
  ) => RuntimePtyWorktreeRecord
  getLivePtyForHandle: (
    handle: string,
    context?: TerminalIdentityReadContext
  ) => { record: TerminalHandleRecord; pty: RuntimePtyWorktreeRecord } | null
  getPtyRecordForPaneKey: (
    pane: string,
    context?: TerminalIdentityReadContext
  ) => RuntimePtyWorktreeRecord | null
  setPtyConnected: (pty: RuntimePtyWorktreeRecord, connected: boolean) => void
  dropDisconnectedPtyRecord: (id: string) => void
  beginGraphReload: (windowId: number) => number
  findHandleForPtyRecord: (ptyId: string, context?: TerminalIdentityReadContext) => string | null
  issueHandle: (leaf: RuntimeLeafRecord, context?: TerminalIdentityReadContext) => string
  rejectWaitersForHandle: (handle: string, reason: string) => void
}

class IdentityRuntime extends OrcaRuntimeService {
  identityOwner(): Owner {
    const current = () => this
    return {
      source: this.terminalIdentity,
      getLeavesForPty: this.getLeavesForPty.bind(this),
      rollbackLegacy: this.rollbackLegacyWorkerTerminalSurface.bind(this),
      markUnavailable: this.markGraphUnavailable.bind(this),
      crewReaders: {
        getTerminalWorktreeIdForHandle: (handle, context) =>
          this.getTerminalWorktreeIdForHandle(handle, context),
        getTerminalProcessIncarnation: (handle, context) =>
          this.getTerminalProcessIncarnation(handle, context),
        getTerminalHandleForPaneKey: (pane, context) =>
          this.getTerminalHandleForPaneKey(pane, context),
        getPaneKeyForTerminalHandle: (handle, context) =>
          this.getPaneKeyForTerminalHandle(handle, context),
        getTerminalPaneKey: (handle, context) => this.getTerminalPaneKey(handle, context),
        getOrchestrationFleetAgentStatusSnapshot: (context) =>
          this.getOrchestrationFleetAgentStatusSnapshot(context),
        createTerminalIdentityRawInputs: () => this.createTerminalIdentityRawInputs(),
        createTerminalIdentityReadContext: (inputs) =>
          this.createTerminalIdentityReadContext(inputs),
        orchestrationSenderNames: this.orchestrationSenderNames
      },
      get runtimeId() {
        return current().runtimeId
      },
      get rendererGraphEpoch() {
        return current().rendererGraphEpoch
      },
      get terminalWaiters() {
        return current().terminalWaiters
      },
      get crewChanges() {
        return current().crewChanges
      },
      get syntheticTerminalHandles() {
        return current().syntheticTerminalHandles
      },
      get handles() {
        return current().handles
      },
      get handleByPtyId() {
        return current().handleByPtyId
      },
      get handleByLeafKey() {
        return current().handleByLeafKey
      },
      get handleByPtyIncarnation() {
        return current().handleByPtyIncarnation
      },
      get leaves() {
        return current().leaves
      },
      get ptysById() {
        return current().ptysById
      },
      get orchestrationCompatibilitySshTerminals() {
        return current().orchestrationCompatibilitySshTerminals
      },
      getOrchestrationCompatibilitySshTerminal:
        this.getOrchestrationCompatibilitySshTerminal.bind(this),
      recordPtyWorktree: this.recordPtyWorktree.bind(this),
      getLivePtyForHandle: this.getLivePtyForHandle.bind(this),
      getPtyRecordForPaneKey: this.getPtyRecordForPaneKey.bind(this),
      setPtyConnected: this.setPtyConnected.bind(this),
      dropDisconnectedPtyRecord: this.dropDisconnectedPtyRecord.bind(this),
      beginGraphReload: this.beginGraphReload.bind(this),
      findHandleForPtyRecord: this.findHandleForPtyRecord.bind(this),
      issueHandle: this.issueHandle.bind(this),
      rejectWaitersForHandle: this.rejectWaitersForHandle.bind(this)
    }
  }
}

export function identityFixture(
  deps?: ConstructorParameters<typeof IdentityRuntime>[2],
  runtimeStore: ConstructorParameters<typeof IdentityRuntime>[0] = store
) {
  const runtime = new IdentityRuntime(runtimeStore, undefined, deps)
  const owner = runtime.identityOwner()
  const rejected = vi.fn<(handle: string, reason: string) => void>()
  const reject = owner.rejectWaitersForHandle
  Object.defineProperty(runtime, 'rejectWaitersForHandle', {
    value: (handle: string, reason: string) => {
      rejected(handle, reason)
      reject(handle, reason)
    },
    configurable: true
  })
  const add = (id: string, handle: string, paneKey = PANE, connected = true) => {
    owner.recordPtyWorktree(id, TEST_WORKTREE_ID, { paneKey, connected })
    owner.source.bindPty(id, handle)
  }
  const stamp = (handle: string, ptyId: string) => {
    owner.source.setHandle(handle, {
      handle,
      runtimeId: owner.runtimeId,
      rendererGraphEpoch: owner.rendererGraphEpoch,
      worktreeId: TEST_WORKTREE_ID,
      tabId: `pty:${ptyId}`,
      leafId: `pty:${ptyId}`,
      ptyId,
      ptyGeneration: 0
    })
  }
  const state = () => ({
    handles: [...owner.handles].map(([key, record]) => [
      key,
      { ...record, runtimeId: '<runtime>' }
    ]),
    reverse: [...owner.handleByPtyId],
    leaf: [...owner.handleByLeafKey],
    retained: [...owner.handleByPtyIncarnation].map(([key, value]) => [key, { ...value }]),
    synthetic: [...owner.syntheticTerminalHandles],
    rejected: rejected.mock.calls
  })
  return { runtime, owner, add, stamp, state, rejected }
}
