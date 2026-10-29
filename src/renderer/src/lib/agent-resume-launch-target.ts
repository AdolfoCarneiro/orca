import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { resolveWindowsShellOverride } from '@/lib/pane-manager/windows-pty-compatibility'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { isWslUncPath } from '../../../shared/wsl-paths'
import {
  canonicalizeWindowsShellOverride,
  resolveLocalWindowsAgentStartupShell,
  resolveWindowsShellStartupFamily
} from '../../../shared/windows-terminal-shell'
import type { AppState } from '@/store/types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'

export type AgentResumeLaunchTarget = {
  platform: NodeJS.Platform
  /** OS that runs the agent; `platform` keeps a paired server's prior quoting. null when unreported. */
  agentHostPlatform: NodeJS.Platform | null
  /** undefined keeps the platform default: PowerShell on win32, POSIX elsewhere. */
  shell: AgentStartupShell | undefined
}

export type AgentResumeLaunchTargetArgs = {
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  /** SSH connection owning the workspace, if any. */
  connectionId: string | null | undefined
  /** Pane/workspace execution owner; only a 'local' host is the one `terminalWindowsShell` describes. */
  executionHostId: string | null
  worktreePath: string | null | undefined
  terminalWindowsShell: string | null | undefined
  /** Per-tab Windows shell override, which beats the global setting at spawn time. */
  tabShellOverride?: string | null
  /** OS the SSH execution host reported; null/undefined when unknown. */
  remotePlatform?: NodeJS.Platform | null
  /** OS a paired Orca server reported; null/undefined when unknown. */
  runtimeHostPlatform?: NodeJS.Platform | null
}

function isRemoteResumeTarget(args: AgentResumeLaunchTargetArgs): boolean {
  return Boolean(args.connectionId) || parseExecutionHostId(args.executionHostId)?.kind !== 'local'
}

/** Use reported OS only for SSH; paired servers choose Windows shell settings this client cannot see, preserving their prior resume quoting. */
export function resolveSshHostReportedPlatform(
  state: Pick<AppState, 'sshConnectionStates' | 'sshStateByEnvironment'>,
  executionHostId: string | null,
  /** Paired server that owns the SSH target, when it is not this client's own connection. */
  sshOwnerEnvironmentId: string | null
): NodeJS.Platform | null {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind !== 'ssh') {
    return null
  }
  const sshState = sshOwnerEnvironmentId
    ? state.sshStateByEnvironment.get(sshOwnerEnvironmentId)?.connectionStates.get(host.targetId)
    : state.sshConnectionStates.get(host.targetId)
  return sshState?.remotePlatform ?? null
}

/** OS a paired Orca server last reported, for `runtime:` hosts only. */
export function resolveRuntimeHostReportedPlatform(
  state: Pick<AppState, 'runtimeStatusByEnvironmentId'>,
  executionHostId: string | null
): NodeJS.Platform | null {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind !== 'runtime') {
    return null
  }
  return (
    lastVerifiedRuntimeStatus(state.runtimeStatusByEnvironmentId.get(host.environmentId))
      ?.hostPlatform ?? null
  )
}

function resolveResumeLaunchPlatform(args: AgentResumeLaunchTargetArgs): NodeJS.Platform {
  if (args.projectRuntime?.status === 'repair-required') {
    return args.projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }
  if (args.remotePlatform && isRemoteResumeTarget(args)) {
    // Why: a WSL UNC cwd on a Windows host still launches inside that distro.
    return args.remotePlatform === 'win32' && args.worktreePath && isWslUncPath(args.worktreePath)
      ? 'linux'
      : args.remotePlatform
  }
  if (args.connectionId || (args.worktreePath && isWslUncPath(args.worktreePath))) {
    return 'linux'
  }
  return CLIENT_PLATFORM
}

/** Quote for both host platform and live shell; typing PowerShell quotes into cmd.exe passes literal quotes that agent CLIs reject (#12320). */
function resolveResumeAgentHostPlatform(
  args: AgentResumeLaunchTargetArgs,
  platform: NodeJS.Platform
): NodeJS.Platform | null {
  if (!isRemoteResumeTarget(args) || args.remotePlatform) {
    return platform
  }
  // Why: an SSH host that has not reported its OS may be Windows; leave it unknown.
  if (args.connectionId || parseExecutionHostId(args.executionHostId)?.kind !== 'runtime') {
    return null
  }
  // Why: a WSL UNC workspace on a Windows server runs its agents inside that distro.
  return args.runtimeHostPlatform === 'win32' &&
    args.worktreePath &&
    isWslUncPath(args.worktreePath)
    ? 'linux'
    : (args.runtimeHostPlatform ?? null)
}

export function resolveAgentResumeLaunchTarget(
  args: AgentResumeLaunchTargetArgs
): AgentResumeLaunchTarget {
  const platform = resolveResumeLaunchPlatform(args)
  const agentHostPlatform = resolveResumeAgentHostPlatform(args, platform)
  const isRemote = isRemoteResumeTarget(args)
  if (isRemote && platform === 'win32' && args.remotePlatform === 'win32') {
    // Client shell settings do not describe remote hosts; a remote tab’s explicit shell override does.
    const override = args.tabShellOverride
      ? canonicalizeWindowsShellOverride(args.tabShellOverride.trim())
      : undefined
    return {
      platform,
      agentHostPlatform,
      shell: override ? resolveWindowsShellStartupFamily(override) : undefined
    }
  }
  return {
    platform,
    agentHostPlatform,
    shell: resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: resolveWindowsShellOverride(
        args.tabShellOverride,
        args.terminalWindowsShell
      )
    })
  }
}
