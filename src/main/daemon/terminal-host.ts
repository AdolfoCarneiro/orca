import { TerminalCreationWork, type PendingTerminalCreation } from './terminal-creation-work'
import { beginTerminalHostFencedTermination } from './terminal-host-fenced-termination'
import type { PtyFencedTerminationRequest } from '../../shared/pty-fenced-termination'
import type { Session } from './session'
import { SessionNotFoundError, type SessionInfo } from './types'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import type { TerminalHostOptions } from './terminal-host-options'
import { disposeTerminalHostSessions, killLiveSessionGroupsSync } from './terminal-host-disposal'
import { getAliveTerminalHostSession } from './terminal-host-session-access'
import { writeSessionInput } from './session-input-path'
import { TerminalSessionTeardown } from './terminal-session-teardown'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import { createOrAttachClaimedAgentSession } from './terminal-host-agent-session-claim'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import { TerminalHostAgentSessionGenerations } from './terminal-host-agent-session-generations'
import { TerminalHostTombstones } from './terminal-host-tombstones'
import { listLiveTerminalHostSessions } from './terminal-host-session-listing'
import { createOrAttachTerminalSession } from './terminal-host-session-create'
import { TerminalAttachCanceledError } from './daemon-errors'
import { waitForTerminalAttachOperation } from './terminal-attach-cancellation'
import { randomUUID } from 'node:crypto'
import { pruneRetiredPtyIncarnations } from '../../shared/retired-pty-incarnations'
import { TerminalHostInspection } from './terminal-host-inspection'
export type { CreateOrAttachOptions, CreateOrAttachResult } from './terminal-host-create-contract'

export type { TerminalHostOptions } from './terminal-host-options'

const DEFAULT_MAX_TOMBSTONES = 1000
const REMOTE_FOREGROUND_TOMBSTONE_RETENTION_MS = 2_000

export class TerminalHost extends TerminalHostInspection {
  protected sessions = new Map<string, Session>()
  // Serializes creates for one id across async spawn validation.
  private pendingCreations = new Map<string, PendingTerminalCreation>()
  private sessionTeardown = new TerminalSessionTeardown(this.sessions)
  private killedTombstones: TerminalHostTombstones
  private readonly spawnOptions: Pick<TerminalHostOptions, 'spawnSubprocess' | 'spawnGate'>
  private onSessionReaped: TerminalHostOptions['onSessionReaped']
  private reportReadinessEvent: TerminalHostOptions['reportReadinessEvent']
  private onFinalCheckpoint: TerminalHostOptions['onFinalCheckpoint']
  private creationFenced = false
  private disposePromise: Promise<void> | null = null
  private readonly agentSessionOwners = new ClaimedAgentPtyOwnerRegistry()
  private readonly agentSessionGenerations = new TerminalHostAgentSessionGenerations()
  protected readonly authorityGeneration = randomUUID()
  protected observationEpoch = 0
  protected readonly retiredIncarnations = new Map<
    string,
    { incarnationId: string; code: number; expiresAt: number }
  >()

  constructor(opts: TerminalHostOptions) {
    super()
    this.spawnOptions = opts
    this.onSessionReaped = opts.onSessionReaped
    this.reportReadinessEvent = opts.reportReadinessEvent
    this.onFinalCheckpoint = opts.onFinalCheckpoint
    this.killedTombstones = new TerminalHostTombstones(opts.maxTombstones ?? DEFAULT_MAX_TOMBSTONES)
  }

  noteSpawnPreparation(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.isTerminating) {
      throw new SessionNotFoundError(sessionId)
    }
    session?.noteUse()
  }

  async createOrAttach(opts: InternalCreateOrAttachOptions): Promise<CreateOrAttachResult> {
    const creation = new TerminalCreationWork()
    const original = opts
    opts = {
      ...opts,
      creationWork: creation,
      onPhysicalOwner: (completion, exitCode) => {
        creation.owner(completion, exitCode)
        original.onPhysicalOwner?.(completion, exitCode)
      }
    }
    try {
      this.assertCreateOrAttachAllowed(opts)
      for (
        let inFlight = this.pendingCreations.get(opts.sessionId);
        inFlight !== undefined;
        inFlight = this.pendingCreations.get(opts.sessionId)
      ) {
        // Let canceled callers leave rather than wait behind a cwd probe stuck on an unreachable share.
        const pending = inFlight
        await waitForTerminalAttachOperation(
          pending.recover().then(() => pending.completion),
          opts.cancelSignal,
          opts.sessionId
        )
        this.assertCreateOrAttachAllowed(opts)
      }
      this.assertCreateOrAttachAllowed(opts)

      this.sessions.get(opts.sessionId)?.noteUse()
      let settleCreation: () => void = () => {}
      const pending: PendingTerminalCreation = {
        completion: new Promise<void>((resolve) => {
          settleCreation = resolve
        }),
        recover: async () => {
          const disposition = await creation.completion
          if (disposition.kind !== 'no-fork') {
            await disposition.recover?.()
          }
        }
      }
      this.pendingCreations.set(opts.sessionId, pending)
      let published = false
      try {
        const result = await createOrAttachClaimedAgentSession({
          options: opts,
          owners: this.agentSessionOwners,
          check: opts.retainCanceledChild
            ? () => this.assertCreateOrAttachAllowed(opts)
            : undefined,
          isLive: (owner) => {
            const session = this.sessions.get(owner.ptyId)
            const live = this.agentSessionGenerations.isCurrent(
              owner,
              Boolean(session?.isAlive && !session.isTerminating)
            )
            if (live && session) {
              creation.owner(session.physicalCompletion, () => session.exitCode)
            }
            return live
          },
          createOrAttach: async (options) => {
            this.assertCreateOrAttachAllowed(options)
            if (options.agentSessionGeneration && this.sessions.get(options.sessionId)?.isAlive) {
              throw new Error('agent_session_claim_unavailable')
            }
            return await createOrAttachTerminalSession(options, {
              sessions: this.sessions,
              assertCreateAllowed: () => this.assertCreateOrAttachAllowed(options),
              sessionTeardown: this.sessionTeardown,
              killedTombstones: this.killedTombstones,
              spawnSubprocess: this.spawnOptions.spawnSubprocess,
              spawnGate: this.spawnOptions.spawnGate,
              onDeadSessionRemoved: (sessionId) => this.agentSessionGenerations.forget(sessionId),
              onSessionCreated: (sessionId, generation, isAlive) =>
                this.agentSessionGenerations.remember(sessionId, generation, isAlive),
              ...(this.reportReadinessEvent
                ? { reportReadinessEvent: this.reportReadinessEvent }
                : {}),
              onSessionExit: this.handleSessionExit.bind(this)
            })
          }
        })
        published = true
        return result
      } finally {
        const finish = () => {
          if (this.pendingCreations.get(opts.sessionId) === pending) {
            this.pendingCreations.delete(opts.sessionId)
          }
          settleCreation()
        }
        if (published || this.sessions.has(opts.sessionId)) {
          finish()
        } else {
          void creation.completion.then(async (disposition) => {
            if (disposition.kind === 'unknown') {
              return
            }
            if (disposition.kind === 'physical' || disposition.kind === 'failed') {
              await disposition.completion
            }
            finish()
          })
        }
      }
    } finally {
      await creation.finish(async (release) => {
        // Registered Sessions retain their ordinary current/use-fenced close authority.
        if (!this.sessions.has(opts.sessionId)) {
          await release()
        }
      })
      const disposition = await creation.completion
      original.onCreationDisposition?.(disposition)
      if (!this.sessions.has(opts.sessionId) && disposition.kind !== 'no-fork') {
        // Failed unpublished resources keep the same ordinary cleanup owner across Retry/disposal.
        void disposition.recover?.().catch(() => {})
      }
    }
  }

  private handleSessionExit(sessionId: string, generation: string | undefined): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      pruneRetiredPtyIncarnations(this.retiredIncarnations)
      this.retiredIncarnations.set(sessionId, {
        incarnationId: session.incarnationId,
        code: session.exitCode ?? 0,
        expiresAt: Date.now() + REMOTE_FOREGROUND_TOMBSTONE_RETENTION_MS
      })
    }
    this.agentSessionOwners.release(sessionId, generation)
    this.agentSessionGenerations.forget(sessionId, generation)
    this.reapSession(sessionId)
  }

  private assertCreateOrAttachAllowed(opts: InternalCreateOrAttachOptions): void {
    if (this.creationFenced) {
      throw new Error('Terminal host is shutting down')
    }
    if (opts.isCanceled?.()) {
      throw new TerminalAttachCanceledError(opts.sessionId)
    }
  }

  write(sessionId: string, data: string): void {
    writeSessionInput(getAliveTerminalHostSession(this.sessions, sessionId), data)
  }

  closeStartupQueryAuthority(sessionId: string): number {
    return getAliveTerminalHostSession(this.sessions, sessionId).closeStartupQueryAuthority()
  }

  resize(sessionId: string, cols: number, rows: number): void {
    getAliveTerminalHostSession(this.sessions, sessionId).resize(cols, rows)
  }

  // Producer flow-control hints tolerate sessions that have already exited.
  pauseProducer(sessionId: string, source?: 'stream', onStreamStall?: () => void): void {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      return
    }
    session.pauseProducer(source, onStreamStall)
  }

  resumeProducer(sessionId: string, source?: 'stream'): void {
    this.sessions.get(sessionId)?.resumeProducer(source)
  }

  kill(
    sessionId: string,
    opts: { immediate?: boolean; switchCheck?: () => boolean; ownedSpawn?: true } = {}
  ): Promise<void> {
    const pending = this.sessionTeardown.get(sessionId)
    if (pending) {
      if (opts.switchCheck) {
        return Promise.resolve()
      }
      return Promise.resolve(
        opts.immediate ? this.sessionTeardown.requestImmediate(sessionId) : pending
      )
    }
    const session = getAliveTerminalHostSession(this.sessions, sessionId)
    const killed = this.sessionTeardown.killSession(
      sessionId,
      session,
      opts.immediate === true,
      opts.switchCheck,
      opts.ownedSpawn
    )
    if (!opts.switchCheck) {
      this.killedTombstones.record(sessionId)
    }
    return Promise.resolve(killed).then(() => {
      if (opts.switchCheck && (!session.isAlive || session.isTerminating)) {
        this.killedTombstones.record(sessionId)
      }
    })
  }

  beginFencedTermination(request: PtyFencedTerminationRequest) {
    return beginTerminalHostFencedTermination(request, {
      sessions: this.sessions,
      pendingCreations: this.pendingCreations,
      owners: this.agentSessionOwners,
      kill: (id, options) => this.kill(id, options)
    })
  }

  // Reap the emulator so dead sessions do not retain scrollback for the daemon’s lifetime.
  private reapSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.isAlive) {
      return
    }
    session.dispose()
    this.sessions.delete(sessionId)
    this.onSessionReaped?.(sessionId)
  }

  // Checkpoint reads tolerate sessions that have just exited.

  // Seed scan-authority handoff with the incomplete escape at the current stream position.

  // Let the renderer detect dropped or coerced resizes from the applied dimensions.

  isKilled(sessionId: string): boolean {
    return this.killedTombstones.has(sessionId)
  }

  listSessions(): SessionInfo[] {
    return listLiveTerminalHostSessions(this.sessions, this.agentSessionOwners)
  }

  /** Last resort when shutdown overruns its deadline: an async group sweep may not have signalled yet. */
  killLiveSessionGroupsSync(): void {
    killLiveSessionGroupsSync(this.sessions.values())
  }

  dispose(): Promise<void> {
    this.creationFenced = true
    if (this.disposePromise) {
      return this.disposePromise
    }
    const disposePromise = disposeTerminalHostSessions({
      pendingCreations: this.pendingCreations,
      sessionTeardown: this.sessionTeardown,
      sessions: this.sessions,
      onFinalCheckpoint: this.onFinalCheckpoint,
      killedTombstones: this.killedTombstones
    })
    this.disposePromise = disposePromise
    void disposePromise.catch(() => {
      // Keep failed native owners retryable on the next shutdown request.
      if (this.disposePromise === disposePromise) {
        this.disposePromise = null
      }
    })
    return disposePromise
  }
}
