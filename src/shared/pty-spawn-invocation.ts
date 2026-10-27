import type { AgentTerminalResume } from './agent-terminal-resume'
import type {
  AgentProviderSessionMetadata,
  SavedResumeDecision,
  SleepingAgentLaunchConfig,
  TerminalLaunchResult
} from './agent-session-resume'
import type { AgentPaneLaunchRequest } from './agent-pane-launch-request'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import type { SpawnIntent } from './host-spawn-admission'
import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'
import type { TerminalPanePlacement } from './terminal-pane-placement'
import type { AgentKind, LaunchSource, RequestKind } from './telemetry-events'
import type { TuiAgent } from './tui-agent'
import type { RESUME_LAUNCH_NOT_DISPATCHED } from './agent-terminal-resume-outcome'

export type PtySpawnRequest = {
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  commandDelivery?: 'renderer' | 'provider'
  launchConfig?: SleepingAgentLaunchConfig
  resume?: AgentTerminalResume
  resumeProviderSession?: AgentProviderSessionMetadata
  resumeOrigin?: 'saved'
  launchToken?: string
  launchAgent?: TuiAgent
  startupCommandDelivery?: StartupCommandDelivery
  connectionId?: string | null
  worktreeId?: string
  sessionId?: string
  shellOverride?: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  terminalKittyKeyboardProtocol?: boolean
  terminalColorQueryReplies?: { foreground?: string; background?: string }
  // Set before the first byte so the delivery gate owns spawn-time queries.
  initiallyHidden?: boolean
  // Layout-owner build: attach to `sessionId` or start nothing; older mains ignore it.
  attachOnlyView?: boolean
  // Main persists the pane-to-PTY binding before replying so SIGKILL cannot lose ownership.
  tabId?: string
  leafId?: string
  // Stop this PTY before restarting; otherwise a live pane owner is reattached.
  replacesPtyId?: string
  // Which tab and leaf a fresh PTY joins; older mains ignore it.
  placement?: TerminalPanePlacement
  // Visible restores are `user-resume`, hidden ones `automatic-restore`; the fork gate validates.
  spawnIntent?: SpawnIntent
  agentLaunch?: AgentPaneLaunchRequest
  // Main emits agent_started only after a successful spawn.
  telemetry?: { agent_kind: AgentKind; launch_source: LaunchSource; request_kind: RequestKind }
}

export type PtySpawnReply = {
  id: string
  /** Which lifetime of `id` this reply named; absent when the execution host predates the field. */
  incarnationId?: string
  launchAgent?: TuiAgent
  launchConfig?: SleepingAgentLaunchConfig
  snapshot?: string
  snapshotCols?: number
  snapshotRows?: number
  snapshotPrefixAnsi?: string
  snapshotFrameAnsi?: string
  snapshotFrameRestoreAnsi?: string
  snapshotKittyKeyboardFlags?: number
  snapshotTerminalOwner?: 'shell'
  snapshotSeq?: number
  isReattach?: boolean
  isAlternateScreen?: boolean
  replay?: string
  sessionExpired?: boolean
  coldRestore?: { scrollback: string; cwd: string; cols?: number; rows?: number }
  startupCwdFallback?: { kind: 'worktree'; cwd: string }
  agentResumeUnavailable?: true
  agentResumeRefused?: 'chat-home' | 'chat-writing' | 'unverifiable'
  savedResumeDecision?: SavedResumeDecision
  refusedResume?: TerminalLaunchResult['refusedResume']
  launchToken?: string
  resumeProviderSession?: TerminalLaunchResult['resumeProviderSession']
  /** Host verdict on the shell-ready marker; absent when the execution host predates the field. */
  shellReadyArmed?: boolean
}

export type PtyResumePlanRefusal = {
  ok: false
  error: { code: 'runtime_error'; message: string; data: typeof RESUME_LAUNCH_NOT_DISPATCHED }
}

export type PtySpawnApi = {
  (
    opts: PtySpawnRequest & { resume: AgentTerminalResume }
  ): Promise<PtySpawnReply | PtyResumePlanRefusal>
  (opts: PtySpawnRequest & { resume?: undefined }): Promise<PtySpawnReply>
  (opts: PtySpawnRequest): Promise<PtySpawnReply | PtyResumePlanRefusal>
}
