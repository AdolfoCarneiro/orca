import type { PtyCreationDisposition } from '../../shared/claimed-agent-pty-owner'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'
import {
  discardStagedStartupCommand,
  stageStartupCommand,
  startupStagingFailureNotice,
  type StartupCommandStaging
} from '../../shared/startup-command-staging'
import { resolvePtyOwnerBackend } from '../../shared/pty-owner-backend'
import { getDaemonSessionResultMetadata } from './daemon-create-or-attach-result'
import { Session } from './session'
import { SessionTerminationController } from './session-termination-controller'
import { shutdownOwnedTerminalProcess } from './terminal-host-session-shutdown'
import { shellPathSupportsPtyStartupBarrier } from './shell-ready'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import { resolveDaemonSessionScrollbackRows } from './daemon-session-scrollback-window'
import { TerminalAttachCanceledError } from './daemon-errors'
import { recordSessionSpawnPaneKey } from './terminal-host-session-listing'
import {
  attachSessionInputViewer,
  isSessionInputClosed,
  trackSessionInput
} from './session-input-path'
import {
  createSessionExitHandler,
  isCwdReadableByThisProcess
} from './terminal-host-session-process'
import type { TerminalHostSessionCreateDependencies } from './terminal-host-session-create'
export async function spawnAndPublishSession(
  opts: InternalCreateOrAttachOptions,
  deps: TerminalHostSessionCreateDependencies,
  ctx: { size: { cols: number; rows: number }; wslDistro: string | undefined },
  onPublished: (sessionId: string, isAlive: boolean) => void
): Promise<CreateOrAttachResult> {
  const { size, wslDistro } = ctx
  // Only macOS needs the TCC probe; other hosts must not pin extra filesystem workers.
  const cwdReadableByDaemon =
    process.platform === 'darwin' && opts.cwd && !wslDistro
      ? await isCwdReadableByThisProcess(opts.cwd, opts)
      : null
  deps.assertCreateAllowed()
  const lower = Promise.withResolvers<PtyCreationDisposition>()
  opts.creationWork?.join(lower.promise)
  let lowerReported = false
  let recoverCreated: (() => Promise<void>) | undefined
  let subprocess: SubprocessHandle
  try {
    subprocess = await deps.spawnSubprocess({
      onCreationDisposition: (disposition) => {
        lowerReported = true
        lower.resolve(disposition)
      },
      sessionId: opts.sessionId,
      cols: size.cols,
      rows: size.rows,
      cwd: opts.cwd,
      env: opts.env,
      envToDelete: opts.envToDelete,
      command: opts.command,
      startupCommandDelivery: opts.startupCommandDelivery,
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      shellOverride: opts.shellOverride,
      terminalShellArgs: opts.terminalShellArgs,
      terminalWindowsWslDistro: opts.terminalWindowsWslDistro,
      terminalWindowsPowerShellImplementation: opts.terminalWindowsPowerShellImplementation,
      isCanceled: opts.isCanceled,
      assertCreateAllowed: deps.assertCreateAllowed,
      retainCanceledChild: opts.retainCanceledChild,
      ...(opts.cancelSignal ? { cancelSignal: opts.cancelSignal } : {})
    })
    // External implementations returning a handle have transferred an actual resource.
    const exited = Promise.withResolvers<void>()
    let code: number | null = null
    let exitCause: TerminalExitCause | undefined
    let sessionExit: Parameters<typeof subprocess.onExit>[0] | undefined
    const rawTermination = new SessionTerminationController({
      sessionId: opts.sessionId,
      subprocess,
      isExited: () => code !== null,
      releaseProducerPause: ({ resume }) => {
        if (resume) {
          subprocess.resume?.()
        }
      }
    })
    recoverCreated = () =>
      shutdownOwnedTerminalProcess({
        pid: subprocess.pid,
        isAlive: () => code === null,
        terminateOwnedTree: () => subprocess.terminateOwnedTree(),
        close: async () => {
          await rawTermination.forceKillAndWaitForExit()
          rawTermination.disposeSubprocessHandle()
        }
      })
    subprocess.onExit((value, cause) => {
      code = value
      exitCause = cause
      rawTermination.markPhysicalExit()
      deps.spawnGate?.onSessionExit(opts.sessionId)
      exited.resolve()
      sessionExit?.(value, cause)
    })
    subprocess.onExit = (callback) => {
      sessionExit = callback
      if (code !== null) {
        callback(code, exitCause)
      }
    }
    if (!lowerReported) {
      lower.resolve({
        kind: 'physical',
        completion: exited.promise,
        exitCode: () => code,
        recover: async () => {
          await recoverCreated?.()
        }
      })
    }
    opts.onPhysicalOwner?.(exited.promise, () => code)
    onPublished(opts.sessionId, code === null)
  } catch (error) {
    if (!lowerReported) {
      lower.resolve({ kind: 'unknown' })
    }
    throw error
  }

  let staging: StartupCommandStaging | undefined
  // Reconcile fallback-shell capability or its first command could remain queued until timeout.
  const shellReadySupported =
    (opts.shellReadySupported ?? false) &&
    (subprocess.shellPath === undefined || shellPathSupportsPtyStartupBarrier(subprocess.shellPath))
  const session = new Session({
    sessionId: opts.sessionId,
    cols: size.cols,
    rows: size.rows,
    terminalHandle: opts.env?.ORCA_TERMINAL_HANDLE,
    launchAgent: opts.launchAgent,
    subprocess,
    ownerBackend: resolvePtyOwnerBackend({
      platform: process.platform,
      shellPath: subprocess.shellPath,
      wslDistro
    }),
    shellReadySupported,
    scrollback: resolveDaemonSessionScrollbackRows(),
    historySeedChunks: opts.historySeedChunks,
    ...(opts.startupIngress ? { startupIngress: opts.startupIngress } : {}),
    wslDistro,
    onExit: createSessionExitHandler(
      deps.onSessionExit,
      opts.sessionId,
      opts.agentSessionGeneration,
      () => discardStagedStartupCommand(staging),
      deps.spawnGate
    ),
    ...(deps.reportReadinessEvent ? { reportReadinessEvent: deps.reportReadinessEvent } : {}),
    ...(opts.shellReadyTimeoutMs !== undefined
      ? { shellReadyTimeoutMs: opts.shellReadyTimeoutMs }
      : {})
  })
  recoverCreated = () =>
    shutdownOwnedTerminalProcess({
      pid: session.pid,
      isAlive: () => session.isAlive,
      terminateOwnedTree: () => session.terminateOwnedTree(),
      close: async () => {
        await session.forceKillAndWaitForExit()
        session.dispose()
      }
    })
  opts.onPhysicalOwner?.(session.physicalCompletion, () => session.exitCode)
  recordSessionSpawnPaneKey(session, opts.env?.ORCA_PANE_KEY)

  try {
    trackSessionInput(session, subprocess, deps.reportReadinessEvent)
  } catch (error) {
    void session.physicalCompletion.then(() => session.dispose())
    throw error
  }

  let revoked = false
  try {
    deps.assertCreateAllowed()
  } catch {
    revoked = true
  }
  if (revoked) {
    // Retain cleanup ownership if the native child refuses to exit.
    deps.sessions.set(opts.sessionId, session)
    // Retain the live-cap charge until physical exit.
    onPublished(opts.sessionId, session.isAlive)
    await session.forceKillAndWaitForExit().catch(() => {})
    if (!session.isAlive && deps.sessions.get(opts.sessionId) === session) {
      session.dispose()
      deps.sessions.delete(opts.sessionId)
      deps.onDeadSessionRemoved(opts.sessionId)
      deps.spawnGate?.onSessionExit(opts.sessionId)
    }
    if (!session.isAlive) {
      throw new TerminalAttachCanceledError(opts.sessionId)
    }
    deps.onSessionCreated(opts.sessionId, opts.agentSessionGeneration, true)
    return {
      isNew: true,
      switchOutcomeUnknown: true,
      switchCleanupWitness: session.captureSwitchWitness(),
      snapshot: session.getSnapshot(),
      pid: session.pid,
      shellState: session.shellState,
      incarnationId: session.incarnationId,
      ...getDaemonSessionResultMetadata(session),
      attachToken: Symbol('retained-switch-child')
    }
  }

  deps.sessions.set(opts.sessionId, session)
  deps.onSessionCreated(opts.sessionId, opts.agentSessionGeneration, session.isAlive)
  onPublished(opts.sessionId, session.isAlive)
  const token = session.attachClient(opts.streamClient)
  attachSessionInputViewer(session, opts.streamClient)

  const startupCommandWritten =
    Boolean(opts.command) && !subprocess.startupCommandDeliveredInShellArgs
  // Distinguish absent from undelivered commands; log only length because command text may contain credentials.
  try {
    deps.reportReadinessEvent?.('startup-command-delivery', {
      sessionId: opts.sessionId,
      written: startupCommandWritten,
      hasCommand: Boolean(opts.command),
      commandLength: opts.command?.length ?? 0,
      viaShellArgs: subprocess.startupCommandDeliveredInShellArgs === true,
      queuedByShellReadyBarrier: shellReadySupported
    })
  } catch {
    // Diagnostics must never turn a live PTY into a failed create.
  }
  if (startupCommandWritten && opts.command) {
    staging = stageStartupCommand({
      command: opts.command,
      shellPath: subprocess.shellPath,
      orcaBuiltLine: opts.launchAgent !== undefined
    })
    const notice = startupStagingFailureNotice(staging)
    if (notice) {
      session.startupIngress.accept(notice)
      try {
        deps.reportReadinessEvent?.('startup-command-stage-failed', {
          sessionId: opts.sessionId,
          reason: staging.failure
        })
      } catch {
        // Diagnostics must never turn a live PTY into a failed create.
      }
    }
    // Why: only Orca-wrapped shells advertise the paste-safe startup barrier.
    session.writeStartupCommand(
      buildStartupCommandSubmission(staging.command, {
        bracketedPasteSafe: shellReadySupported
      })
    )
  }

  return {
    isNew: true,
    ...(opts.retainCanceledChild ? { switchCleanupWitness: session.captureSwitchWitness() } : {}),
    snapshot: null,
    pid: subprocess.pid,
    shellState: session.shellState,
    incarnationId: session.incarnationId,
    ...getDaemonSessionResultMetadata(session),
    ...(isSessionInputClosed(session) ? { inputClosed: true as const } : {}),
    ...(cwdReadableByDaemon !== null ? { cwdReadableByDaemon } : {}),
    attachToken: token
  }
}
