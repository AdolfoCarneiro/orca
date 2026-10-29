import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { UseDetectedAgentsResult } from '@/hooks/useDetectedAgents'
import type { ProspectiveWorkspace } from '@/lib/agent-launch-route-input'
import type { buildNewTabAgentMenuRows } from '@/lib/new-tab-agent-menu-rows'

export type NewTabAgentMenuModel =
  | { state: 'loading'; placeholderCount: number }
  | {
      state: 'settled'
      rows: ReturnType<typeof buildNewTabAgentMenuRows>
      detection: UseDetectedAgentsResult
      /** The default these rows were ordered by, so the new-agent badge marks the same agent. */
      defaultTuiAgent?: GlobalSettings['defaultTuiAgent']
    }

/** A launch whose workspace may not exist yet, or that starts in a directory of its own. */
export type AgentMenuRowsTarget = {
  workspace: ProspectiveWorkspace
  /** Only a terminal can start here, so chat rows say so instead of dropping the directory. */
  launchCwd?: string | null
}

/** `wakeOnOpen`: `open` is the user opening this picker, a user act that may start its WSL distro. */
export type AgentMenuObservationOptions = { wakeOnOpen?: boolean }
