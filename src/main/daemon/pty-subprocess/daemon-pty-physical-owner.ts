import type { DisposableNativePty } from './native-pty-spawn'
import type * as pty from 'node-pty'
import { forceKillPosixPtyProcessGroups } from '../../pty/posix-pty-process-groups'
import { PendingPtyGroupSweep } from '../../pty/pending-pty-group-sweep'
import { terminatePtyJob } from '../../windows/windows-pty-job'
import { SessionTerminationController } from '../session-termination-controller'
import { shutdownOwnedTerminalProcess } from '../terminal-host-session-shutdown'
export function createDaemonPtyPhysicalOwner(proc: pty.IPty) {
  const nativeProc: DisposableNativePty = proc
  let exited = false
  let code: number | null = null
  let disposed = false
  let nodePtyKillIssued = false
  const groupSweep = new PendingPtyGroupSweep()
  const killRoot = (): void => {
    process.kill(proc.pid, 'SIGKILL')
  }
  const fallBackToNodePtyKill = (signalError: unknown): void => {
    try {
      proc.kill()
      nodePtyKillIssued = true
    } catch {
      nodePtyKillIssued = false
      throw signalError
    }
  }
  const forceKillPosix = async (): Promise<void> => {
    if (exited) {
      return
    }
    // A reaped root frees its pid and TTY for reuse, so a table read that outlives it signals nothing.
    await groupSweep.track(
      forceKillPosixPtyProcessGroups(proc.pid, killRoot, { ownsRoot: () => !exited }).catch(
        fallBackToNodePtyKill
      )
    )
  }
  // Stays synchronous: dispose() reads nodePtyKillIssued right after to avoid double-closing ConPTY.
  const forceKillConpty = (): void => {
    if (exited) {
      return
    }
    // Escalate a ConPTY kill through the job without double-closing node-pty's shell handle.
    if (nodePtyKillIssued) {
      terminatePtyJob(proc)
      return
    }
    try {
      killRoot()
    } catch (signalError) {
      fallBackToNodePtyKill(signalError)
    }
  }

  const kill = (): void => {
    if (exited) {
      return
    }
    nodePtyKillIssued = true
    try {
      proc.kill()
    } catch (error) {
      nodePtyKillIssued = false
      throw error
    }
  }
  const forceKill = () => (process.platform === 'win32' ? forceKillConpty() : forceKillPosix())
  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    const destroy = (): void => {
      try {
        nativeProc.destroy?.()
      } catch {}
    }
    if (process.platform !== 'win32') {
      nativeProc.kill = () => {}
    } else if (nodePtyKillIssued) {
      return
    }
    groupSweep.afterSettled(destroy)
  }
  const termination = new SessionTerminationController({
    sessionId: String(proc.pid),
    subprocess: { kill, forceKill, signal: (signal) => proc.kill(signal), dispose },
    isExited: () => exited,
    releaseProducerPause: ({ resume }) => {
      if (resume) {
        proc.resume()
      }
    }
  })
  proc.onExit(({ exitCode }) => {
    exited = true
    code = exitCode
    termination.markPhysicalExit()
  })
  return {
    completion: termination.physicalCompletion,
    exitCode: () => code,
    hasExited: () => exited,
    kill,
    forceKill,
    dispose,
    recover: () =>
      shutdownOwnedTerminalProcess({
        pid: proc.pid,
        isAlive: () => !exited,
        terminateOwnedTree: () => terminatePtyJob(proc),
        close: async () => {
          await termination.forceKillAndWaitForExit()
          dispose()
        }
      })
  }
}
