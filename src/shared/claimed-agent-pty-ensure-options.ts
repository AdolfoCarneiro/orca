import type { PtyCreationDisposition } from './pty-creation-disposition'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding
} from './agent-session-host-authority'
import type { LiveAgentSessionOwner } from './claimed-agent-pty-owner-snapshot'
export type ClaimedAgentPtyEnsureOptions = {
  claim: AgentSessionExecutionClaim
  surface: AgentSessionSurfaceBinding
  spawn: (reservation: { generation: string }) => Promise<{
    ptyId: string
    owner?: AgentSessionOwnerBinding
    disposition?: AgentSessionClaimedSpawnResult['disposition']
  }>
  isLive?: (owner: LiveAgentSessionOwner) => boolean | Promise<boolean>
  /** Called when this request waits on another request's start instead of starting its own. */
  creation?: Promise<PtyCreationDisposition>
  onJoin?: (creation?: Promise<PtyCreationDisposition>) => void
  /** Checked at mutation, including after asynchronous liveness proof. */
  check?: () => void
  /** Reconcile an already dispatched creator without granting new attach authority. */
  onDispatchedRevoked?: () => void
}
