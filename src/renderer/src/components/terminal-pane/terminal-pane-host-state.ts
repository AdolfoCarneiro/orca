import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { isWindowsHostWslWorkspace } from '@/lib/execution-host-facts'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedWorktreeOwnerForHost
} from '@/lib/worktree-runtime-owner-index'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import type { AppState } from '@/store/types'
import { sshConnectFailureText } from '@/ssh/ssh-host-server-status-copy'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  resolveWorktreeHostConnection,
  type WorktreeHostConnection
} from '@/lib/worktree-host-connection-phase'
import { isNativeChatTranscriptLocalReadable } from '../../../../shared/native-chat/transcript/native-chat-transcript-readability'
import {
  selectRuntimeAwareSshError,
  selectRuntimeAwareSshTargetLabel,
  selectRuntimeAwareSshTargetRemoved
} from '@/store/slices/runtime-environment-ssh'

export type TerminalPaneHostState = {
  /** Null preserves saved views until the owning host and project runtime are known. */
  nativeChatIsWslProject: boolean | null
  nativeChatTranscriptIsLocalReadable: boolean
  sshReconnectEnvironmentId: string | null
  /** The failure detail behind the status; the overlay shows only a canned sentence without it. */
  sshReconnectError: string | null
  sshReconnectStatus: WorktreeHostConnection['publishedStatus']
  sshReconnectTargetId: string | null
  sshReconnectTargetLabel: string
  sshReconnectTargetRemoved: boolean
}

/** An unserved local host's translated reason; main's error stays the English twin. */
function reconnectErrorText(
  state: AppState,
  environmentId: string | null,
  targetId: string,
  error: string | null
): string | null {
  if (error === null || environmentId !== null) {
    return error
  }
  return sshConnectFailureText(state.sshConnectionStates.get(targetId), error)
}

function resolveNativeChatWslProject(state: AppState, worktreeId: string): boolean | null {
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  if (projectRuntime) {
    return projectRuntime.status === 'resolved' ? projectRuntime.runtime.kind === 'wsl' : null
  }
  const owner = parseExecutionHostId(getResolvedExecutionHostIdForWorktree(state, worktreeId) ?? '')
  if (!owner) {
    return null
  }
  if (owner.kind === 'local') {
    return getRendererAppPlatform() === 'win32' ? null : false
  }
  if (owner.kind === 'ssh') {
    return false
  }
  const hostPlatform = lastVerifiedRuntimeStatus(
    state.runtimeStatusByEnvironmentId.get(owner.environmentId)
  )?.hostPlatform
  const scope = parseWorkspaceKey(worktreeId)
  const workspacePath =
    scope?.type === 'folder'
      ? findIndexedFolderWorkspaceOwner(
          selectFolderWorkspaces(state),
          scope.folderWorkspaceId,
          owner.id
        )?.folderPath
      : findIndexedWorktreeOwnerForHost(selectWorktreesByRepo(state), worktreeId, owner.id)?.path
  if (!hostPlatform || (hostPlatform === 'win32' && !workspacePath)) {
    return null
  }
  return hostPlatform === 'win32'
    ? isWindowsHostWslWorkspace(hostPlatform, workspacePath) || null
    : false
}

function computeTerminalPaneHostState(state: AppState, worktreeId: string): TerminalPaneHostState {
  const nativeChatIsWslProject = resolveNativeChatWslProject(state, worktreeId)
  const connectionId = getConnectionIdFromState(state, worktreeId)
  const nativeChatTranscriptIsLocalReadableResult =
    isNativeChatTranscriptLocalReadable(connectionId)
  const host = resolveWorktreeHostConnection(state, worktreeId, connectionId)
  if (!host.targetId) {
    return {
      nativeChatIsWslProject,
      nativeChatTranscriptIsLocalReadable: nativeChatTranscriptIsLocalReadableResult,
      sshReconnectEnvironmentId: null,
      sshReconnectError: null,
      sshReconnectStatus: null,
      sshReconnectTargetId: null,
      sshReconnectTargetLabel: '',
      sshReconnectTargetRemoved: false
    }
  }
  const { targetId: sshReconnectTargetId, environmentId: sshReconnectEnvironmentId } = host
  return {
    nativeChatIsWslProject,
    nativeChatTranscriptIsLocalReadable: nativeChatTranscriptIsLocalReadableResult,
    sshReconnectEnvironmentId,
    sshReconnectError: reconnectErrorText(
      state,
      sshReconnectEnvironmentId,
      sshReconnectTargetId,
      selectRuntimeAwareSshError(state, sshReconnectEnvironmentId, sshReconnectTargetId)
    ),
    sshReconnectStatus: host.publishedStatus,
    sshReconnectTargetId,
    sshReconnectTargetLabel: selectRuntimeAwareSshTargetLabel(
      state,
      sshReconnectEnvironmentId,
      sshReconnectTargetId
    ),
    sshReconnectTargetRemoved: selectRuntimeAwareSshTargetRemoved(
      state,
      sshReconnectEnvironmentId,
      sshReconnectTargetId
    )
  }
}

function isSameHostState(a: TerminalPaneHostState, b: TerminalPaneHostState): boolean {
  return (
    a.nativeChatIsWslProject === b.nativeChatIsWslProject &&
    a.nativeChatTranscriptIsLocalReadable === b.nativeChatTranscriptIsLocalReadable &&
    a.sshReconnectEnvironmentId === b.sshReconnectEnvironmentId &&
    a.sshReconnectError === b.sshReconnectError &&
    a.sshReconnectStatus === b.sshReconnectStatus &&
    a.sshReconnectTargetId === b.sshReconnectTargetId &&
    a.sshReconnectTargetLabel === b.sshReconnectTargetLabel &&
    a.sshReconnectTargetRemoved === b.sshReconnectTargetRemoved
  )
}

// Identity checks must not keep a retired store alive after the last pane unmounts.
let cachedState: WeakRef<AppState> | null = null
let cachedByWorktreeId = new Map<string, TerminalPaneHostState>()
let previousByWorktreeId = new Map<string, TerminalPaneHostState>()

/** Memoize host resolution by whole store identity: ownership spans repo, folder, runtime and SSH state, so narrower keys can miss changes. Resolve once per worktree/publication and reuse unchanged results to avoid per-pane allocations. */
export function selectTerminalPaneHostState(
  state: AppState,
  worktreeId: string
): TerminalPaneHostState {
  if (state !== cachedState?.deref()) {
    previousByWorktreeId = cachedByWorktreeId
    cachedByWorktreeId = new Map()
    cachedState = new WeakRef(state)
  }
  const cached = cachedByWorktreeId.get(worktreeId)
  if (cached) {
    return cached
  }
  const next = computeTerminalPaneHostState(state, worktreeId)
  const previous = previousByWorktreeId.get(worktreeId)
  const result = previous && isSameHostState(previous, next) ? previous : next
  cachedByWorktreeId.set(worktreeId, result)
  return result
}

export function resetTerminalPaneHostStateMemoForTests(): void {
  cachedState = null
  cachedByWorktreeId = new Map()
  previousByWorktreeId = new Map()
}
