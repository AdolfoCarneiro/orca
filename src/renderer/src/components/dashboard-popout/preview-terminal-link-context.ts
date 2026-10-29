import { useAppStore } from '@/store'
import { resolveWorkspaceDirectory } from '@/lib/workspace-directory'
import { resolvePaneWslDistro } from '@/components/terminal-pane/terminal-pane-wsl-distro'
import { httpLinkActionDestinationsFor } from '@/lib/http-link-destinations'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import {
  canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh
} from '@/lib/workspace-browser-route-eligibility'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { handleOscLink } from '@/components/terminal-pane/terminal-osc-link-routing'

export type PreviewTerminalLinkSource = Pick<
  DashboardCard,
  'worktreeId' | 'tabId' | 'executionHostId'
>

/** Resolve on gestures, without subscribing every dashboard preview to workspace changes. */
export function previewTerminalLinkContext(
  source?: PreviewTerminalLinkSource
): Parameters<typeof handleOscLink>[2] {
  const state = useAppStore.getState()
  const host = parseExecutionHostId(source?.executionHostId)
  const worktreePath =
    source && host ? resolveWorkspaceDirectory(state, source.worktreeId, host.id) : null
  const sourceOwner: HttpLinkSourceOwner =
    host?.kind === 'runtime'
      ? { kind: 'runtime', runtimeEnvironmentId: host.environmentId }
      : host?.kind === 'ssh'
        ? { kind: 'ssh', connectionId: host.targetId }
        : { kind: 'local' }
  const worktreeId = source?.worktreeId ?? ''
  const canOpenOwnedBrowser =
    Boolean(worktreePath) &&
    (sourceOwner.kind === 'runtime'
      ? canOpenWorkspaceBrowserTabOnRuntime(state, worktreeId, sourceOwner.runtimeEnvironmentId)
      : sourceOwner.kind === 'ssh' &&
        canOpenWorkspaceBrowserTabOnSsh(state, worktreeId, sourceOwner.connectionId))
  return {
    worktreeId,
    worktreePath: worktreePath ?? '',
    runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null,
    sourceTabId: worktreePath ? source?.tabId : undefined,
    wslDistro:
      worktreePath && host?.kind === 'local'
        ? resolvePaneWslDistro(state, worktreeId, worktreePath)
        : null,
    sourceOwner,
    // A pop-out has no workspace directory or browser surface; use the shared system destination.
    actionDestinations: worktreePath
      ? httpLinkActionDestinationsFor(state.settings, sourceOwner, canOpenOwnedBrowser)
      : { primary: 'system' }
  }
}
