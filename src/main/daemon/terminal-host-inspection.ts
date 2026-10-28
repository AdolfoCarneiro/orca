import { hasLiveTerminalHostSessions } from './terminal-host-session-listing'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'
import {
  getSettledTerminalHostSnapshot,
  getTerminalHostAppliedSize,
  getTerminalHostPartialEscapeTail,
  getTerminalHostSnapshot,
  takeTerminalHostPendingOutput
} from './terminal-host-session-inspection-operations'
import type { Session } from './session'
import type { PtyProcessInspectionOptions } from '../providers/pty-process-inspection'
import { getAliveTerminalHostSession } from './terminal-host-session-access'
import { resolveTerminalHostSessionCwd } from './terminal-host-session-cwd'
import {
  inspectTerminalHostSession,
  type TerminalHostProcessInspection
} from './terminal-host-process-inspection'
import {
  confirmTerminalHostForegroundProcess,
  confirmTerminalHostShellForeground
} from './terminal-host-session-inspection-operations'
export abstract class TerminalHostInspection {
  protected abstract sessions: Map<string, Session>
  protected abstract readonly retiredIncarnations: Map<
    string,
    { incarnationId: string; code: number; expiresAt: number }
  >
  protected abstract readonly authorityGeneration: string
  protected abstract observationEpoch: number
  async getCwd(sessionId: string): Promise<string | null> {
    return await resolveTerminalHostSessionCwd(
      getAliveTerminalHostSession(this.sessions, sessionId)
    )
  }

  // A vanished pane has no agent icon to display.
  getForegroundProcess(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    return session.getForegroundProcess()
  }

  inspectProcess(
    sessionId: string,
    options?: PtyProcessInspectionOptions
  ): Promise<TerminalHostProcessInspection> {
    return inspectTerminalHostSession(
      this.sessions,
      this.retiredIncarnations,
      sessionId,
      options,
      this.authorityGeneration,
      () => ++this.observationEpoch
    )
  }

  async confirmForegroundProcess(sessionId: string): Promise<string | null> {
    return confirmTerminalHostForegroundProcess(this.sessions.get(sessionId))
  }

  async confirmShellForeground(sessionId: string): Promise<boolean> {
    return confirmTerminalHostShellForeground(this.sessions.get(sessionId), () =>
      this.sessions.get(sessionId)
    )
  }

  signal(sessionId: string, sig: string): void {
    getAliveTerminalHostSession(this.sessions, sessionId).signal(sig)
  }

  detach(sessionId: string, token: symbol): void {
    this.detachClients([{ sessionId, token }])
  }

  detachClients(attachments: readonly { sessionId: string; token: symbol }[]): void {
    for (const { sessionId, token } of attachments) {
      this.sessions.get(sessionId)?.detachClient(token)
    }
  }

  clearScrollback(sessionId: string): void {
    getAliveTerminalHostSession(this.sessions, sessionId).clearScrollback()
  }

  resetInputModes(sessionId: string): void {
    getAliveTerminalHostSession(this.sessions, sessionId).resetInputModes()
  }

  getSnapshot(sessionId: string, opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    return getTerminalHostSnapshot(this.sessions.get(sessionId), opts)
  }

  async getSettledSnapshot(
    sessionId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<TerminalSnapshot | null> {
    return getSettledTerminalHostSnapshot(this.sessions.get(sessionId), opts)
  }

  getPartialEscapeTailAnsi(sessionId: string): string {
    return getTerminalHostPartialEscapeTail(this.sessions.get(sessionId))
  }

  getAppliedSize(sessionId: string): { cols: number; rows: number } | null {
    return getTerminalHostAppliedSize(this.sessions.get(sessionId))
  }

  takePendingOutput(
    sessionId: string,
    includeSnapshot: boolean,
    opts: { teardownSnapshot?: boolean } = {}
  ): TakePendingOutputResult | null {
    return takeTerminalHostPendingOutput(this.sessions.get(sessionId), includeSnapshot, opts)
  }

  hasLiveSessions(): boolean {
    return hasLiveTerminalHostSessions(this.sessions)
  }
}
