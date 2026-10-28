import type {
  HistoryRecoveryContext,
  PendingDaemonSpawnOperation
} from './daemon-pty-runtime-state'
import type { ColdRestoreInfo } from './history-reader'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
export type DaemonPtySpawnContext = {
  opts: PtySpawnOptions
  operation: PendingDaemonSpawnOperation
  historyRecovery: HistoryRecoveryContext
  requestedSessionId: string
  attachOnly: boolean
  emulateLegacyAttachOnly: boolean
  sessionId: string
  wslDistro: string | undefined
  restoreInfo: ColdRestoreInfo | null
  restoreSkippedForLiveSession: boolean
  effectiveCwd: string | undefined
  effectiveCols: number
  effectiveRows: number
  shellReadySupported: boolean
  shellReadyTimeoutMs: number | undefined
  historySeedSegments: readonly string[] | null
  detectColdRestore(options?: { ignoreCleanEnd?: boolean }): Promise<ColdRestoreInfo | null>
}
