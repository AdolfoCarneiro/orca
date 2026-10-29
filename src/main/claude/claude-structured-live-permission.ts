import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentChatPermissionChoice,
  AgentChatPermissionMode
} from '../../shared/agent-chat-permission-mode'
import { CLAUDE_PERMISSION_MODES } from './claude-structured-launch-resolution'
import type { ClaudeSession } from './structured/claude-structured-session-state'

const CLAUDE_LIVE_PERMISSION_MODES = {
  ...CLAUDE_PERMISSION_MODES,
  'full-access': 'bypassPermissions'
} as const satisfies Record<AgentChatPermissionMode, PermissionMode>

/** Claude switches modes in place and reports the new one; it refuses Full access unless it was
 *  launched in it, and reads own settings only at launch, so those wait for the next start. */
export async function applyClaudeLivePermissionMode(
  session: ClaudeSession | undefined,
  mode: AgentChatPermissionChoice,
  timeoutMs: number | undefined
): Promise<boolean> {
  if (!session || mode === 'own') {
    return false
  }
  const permissionMode = CLAUDE_LIVE_PERMISSION_MODES[mode]
  try {
    await session.connection.setPermissionMode(permissionMode, { timeoutMs })
  } catch {
    return false
  }
  // It now runs this mode, so a later model change has no startup fallback to undo.
  session.launchIntent = { ...session.launchIntent, permissionMode }
  if (session.firstRootInit) {
    session.firstRootInit = { permissionMode }
  }
  return true
}
