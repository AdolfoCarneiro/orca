import type { AgentSessionSwitchAuthority } from '../../../../shared/agent-session-switch-execution'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch-runtime'
import type { AgentLaunchTabViewerRule } from '../../../../shared/agent-launch-tab-publication'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/launch-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'

export type MobileTerminalCreateOptions = {
  terminalImageViewerSupported?: boolean
  afterTabId?: string
  sourceChatFork?: { sessionId: string }
  targetGroupId?: string
  command?: string
  sessionOptions?: Record<string, string>
  commandOverride?: string
  launchRuntime?: AgentLaunchRuntime
  shellOverride?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  agent?: TuiAgent
  agentPrompt?: string
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  /** A switch's start: its ordinary spawn admission checks the conversation. */
  resumeProviderSession?: AgentProviderSessionMetadata
  resumeOrigin?: 'switch'
  viewMode?: 'terminal' | 'chat'
  activate?: boolean
  clientNavigationId?: string
  clientMutationId?: string
  supportsSplitGroupPlacement?: boolean
  signal?: AbortSignal
  switchExecution?: AgentSessionSwitchAuthority & {
    afterTabId?: string
    viewer: AgentLaunchTabViewerRule
    viewerSelection?: string
  }
}
