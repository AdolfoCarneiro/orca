import {
  getObservedCodexPaneHome,
  restoreCodexPaneHome,
  isCurrentCodexPaneObservation
} from '../../../codex/codex-pane-account-registry'
import type { CodexPaneHomeObservation } from '../../../codex/codex-pane-account-registry-types'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { getPtyIpc } from '../pty-host-bindings'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import {
  findPaneCodexOnSharedServer,
  resolveCodexPaneHome
} from '../../../codex/codex-shared-server-pane'
import {
  disableCodexSharedServerAutoStart,
  stopCodexSharedServer
} from '../../../codex/codex-shared-server-fix'
import { getLegacyDaemonAdapters } from '../../../daemon/daemon-provider-routing'
import {
  CODEX_FISH_SHELL_FUNCTION_DAEMON_PROTOCOL_VERSION,
  CODEX_NO_DAEMON_SHELL_LAUNCH_DAEMON_PROTOCOL_VERSION
} from '../../../daemon/daemon-protocol-version'
import type { CodexSharedServerStatus } from '../../../../shared/codex-shared-server-command'
import { ptyOwnership, ptyIncarnationById } from '../provider/ownership-state'
import { getProviderForPty, hasPtyProviderForInspection } from '../provider/registry'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

// Wrapper availability depends on shell and daemon version; cmd.exe and unknown shells have none.
const CODEX_SHELL_FUNCTION_PROTOCOL_BY_SHELL: ReadonlyMap<string, number> = new Map([
  ['zsh', CODEX_NO_DAEMON_SHELL_LAUNCH_DAEMON_PROTOCOL_VERSION],
  ['bash', CODEX_NO_DAEMON_SHELL_LAUNCH_DAEMON_PROTOCOL_VERSION],
  ['powershell', CODEX_NO_DAEMON_SHELL_LAUNCH_DAEMON_PROTOCOL_VERSION],
  ['pwsh', CODEX_NO_DAEMON_SHELL_LAUNCH_DAEMON_PROTOCOL_VERSION],
  ['fish', CODEX_FISH_SHELL_FUNCTION_DAEMON_PROTOCOL_VERSION]
])

type Deps = { getLocalPtyProviderStartupPromise: () => Promise<void> | undefined }

async function findLocalPaneRootPid(deps: Deps, id: unknown) {
  // WSL/SSH Codex state belongs to the execution host.
  if (
    typeof id !== 'string' ||
    isRemoteRuntimePtyId(id) ||
    parseAppSshPtyId(id) ||
    (ptyOwnership.get(id) ?? LOCAL_EXECUTION_HOST_ID) !== LOCAL_EXECUTION_HOST_ID
  ) {
    return null
  }
  const captured = getObservedCodexPaneHome(id)
  // Restored daemon IDs are not owned by the pre-swap provider.
  await deps.getLocalPtyProviderStartupPromise()
  if (!hasPtyProviderForInspection(id)) {
    return null
  }
  const provider = getProviderForPty(id)
  const session = (await provider.listProcesses()).find((candidate) => candidate.id === id)
  if (
    !session ||
    session.rootProcessId === undefined ||
    session.wslDistro ||
    getProviderForPty(id) !== provider ||
    getObservedCodexPaneHome(id) !== captured
  ) {
    return null
  }
  const observation = restoreCodexPaneHome(id, session.incarnationId)
  if (!observation) {
    return null
  }
  const isCurrent = () => {
    try {
      return (
        (ptyOwnership.get(id) ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID &&
        getProviderForPty(id) === provider &&
        isCurrentCodexPaneObservation(id, observation) &&
        (!ptyIncarnationById.has(id) || ptyIncarnationById.get(id) === observation.incarnationId)
      )
    } catch {
      return false
    }
  }
  return isCurrent() ? { rootPid: session.rootProcessId, observation, isCurrent } : null
}

function handleLocalPane<T>(
  deps: Deps,
  channel: string,
  run: (
    id: string,
    rootPid: number,
    observation: CodexPaneHomeObservation,
    isCurrent: () => boolean
  ) => Promise<T>,
  refused: T
): void {
  getPtyIpc().handle(channel, async (_event, args: { id: string }): Promise<T> => {
    try {
      const target = await findLocalPaneRootPid(deps, args?.id)
      return target === null
        ? refused
        : await run(args.id, target.rootPid, target.observation, target.isCurrent)
    } catch {
      return refused
    }
  })
}

async function readPaneSharedServerStatus(
  id: string,
  rootPid: number,
  observation: CodexPaneHomeObservation,
  isCurrent: () => boolean
): Promise<CodexSharedServerStatus> {
  const codex = await findPaneCodexOnSharedServer(id, rootPid, observation, isCurrent)
  if (!codex) {
    return { joined: false }
  }
  const shellFunctionProtocol = CODEX_SHELL_FUNCTION_PROTOCOL_BY_SHELL.get(codex.shell ?? '')
  const openedBeforeWrapper =
    shellFunctionProtocol !== undefined &&
    getLegacyDaemonAdapters(getProviderForPty(id)).some(
      (adapter) => adapter.hasPty(id) && adapter.protocolVersion < shellFunctionProtocol
    )
  return { joined: true, openedBeforeWrapper }
}

/** Runs a fix command against the pane's own CODEX_HOME, never a guessed one. */
function runForPaneHome(fix: (codexHome: string, isCurrent: () => boolean) => Promise<boolean>) {
  return async (
    id: string,
    _rootPid: number,
    _observation: CodexPaneHomeObservation,
    isCurrent: () => boolean
  ): Promise<boolean> => {
    const codexHome = resolveCodexPaneHome(id)
    return codexHome && isCurrent() ? await fix(codexHome, isCurrent) : false
  }
}

// Only visible Codex panes request this argv read; keep it off cadence polling.
export function installPtyCodexSharedServerIpcHandler(deps: Deps): void {
  handleLocalPane(deps, 'pty:isCodexOnSharedServer', readPaneSharedServerStatus, { joined: false })
  handleLocalPane(
    deps,
    'pty:disableCodexSharedServerAutoStart',
    runForPaneHome(disableCodexSharedServerAutoStart),
    false
  )
  handleLocalPane(deps, 'pty:stopCodexSharedServer', runForPaneHome(stopCodexSharedServer), false)
}
