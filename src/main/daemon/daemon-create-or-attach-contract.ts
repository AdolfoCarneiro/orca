import type { SpawnIntent } from '../../shared/host-spawn-admission'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type * as HistorySeedProtocol from './terminal-history-seed-transfer-protocol'
import type { DaemonCreateOrAttachResult as CreateOrAttachResult } from './daemon-create-or-attach-result'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
export type CreateOrAttachRequest = {
  id: string
  type: 'createOrAttach'
  payload: HistorySeedProtocol.CreateOrAttachHistorySeedPayload & {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    command?: string
    startupCommandDelivery?: StartupCommandDelivery
    launchAgent?: TuiAgent
    /** Rejects an absent session instead of interpreting mount uncertainty as create permission. */
    attachOnly?: boolean
    /** Preserve the selected shell instead of defaulting to the daemon’s platform fallback. */
    shellOverride?: string
    terminalShellArgs?: string[]
    /** Preferred WSL distro for generic `wsl.exe` launches. */
    terminalWindowsWslDistro?: string | null
    /** Preserve the selected PowerShell implementation so daemon and local spawns resolve the same executable. */
    terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
    shellReadySupported?: boolean
    shellReadyTimeoutMs?: number
    /** Server-side fence that prevents a client timeout from publishing an orphan PTY. */
    switchExecution?: {
      phase: 'prepare' | 'commit'
      invocationId: string
      anchor?: string
      contract?: 'creation-settlement-v1'
      remainingMs?: number
    }
    cancelAfterMs?: number
    startupIngress?: PtyStartupIngressIntent
    /** Optional; an old daemon ignores it and an old client omits it (legacy pacing). */
    spawnIntent?: SpawnIntent
    agentSessionEnsure?: {
      claim: AgentSessionExecutionClaim
      surface: AgentSessionSurfaceBinding
    }
  }
}

export type CreateOrAttachSettlement =
  | { outcome: 'exited' }
  | { outcome: 'failed' }
  | { outcome: 'owned'; result: CreateOrAttachResult }
  | { outcome: 'unknown' }

export type CancelCreateOrAttachResult = {
  canceled: boolean
  settlement?: CreateOrAttachSettlement
  retention?: 'creation-settlement-v1'
  released?: boolean
}

export type CancelCreateOrAttachRequest = {
  id: string
  type: 'cancelCreateOrAttach'
  payload: {
    sessionId: string
    requestId?: string
    settlement?: { invocationId: string; anchor: string; endpoint: DaemonEndpointIdentity }
    release?: {
      invocationId: string
      anchor: string
      endpoint: DaemonEndpointIdentity
      outcome: 'exited' | 'adopted' | 'failed'
      incarnationId?: string
    }
  }
}
