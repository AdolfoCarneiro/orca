import type { OrcaRuntimeWithMobileTerminalCreateOwner } from './mobile-terminal-create-owner'
import type { MobileTerminalCreateOptions } from './mobile-terminal-create-options'
import { trackRunningAgentLaunchPane } from '../../../agent-launch/agent-launch-pane-attachment'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { AgentLaunchTabPublished } from '../../../../shared/agent-launch-tab-publication'
import type { AgentLaunchPaneVerdict } from '../../../../shared/agent-launch-pane-verdict'
import type { MobileTerminalCommand } from './mobile-terminal-startup'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import type { AgentSessionSwitchAuthority } from '../../../../shared/agent-session-switch-execution'

export async function createPublishedSwitchTerminal(args: {
  owner: Pick<
    OrcaRuntimeWithMobileTerminalCreateOwner,
    | 'publishAgentLaunchTabInMainLayout'
    | 'publishAgentLaunchTab'
    | 'reportAgentLaunchPaneVerdict'
    | 'hasLiveTerminalForPaneKey'
    | 'withdrawAgentLaunchPaneInMainLayout'
  >
  windowAvailable: () => boolean
  worktreeId: string
  opts: MobileTerminalCreateOptions
  startupCommand: MobileTerminalCommand
  afterDesktopTabId: string | undefined
  createOwned: (
    identity: { tabId: string; leafId: string },
    trackPhysical: NonNullable<AgentSessionSwitchAuthority['trackPhysical']>
  ) => Promise<RuntimeMobileSessionCreateTerminalResult>
  setDestinationCurrent: (check: () => void) => void
  setTargetGroup: (group: string) => void
  wasDispatched: () => boolean
}): Promise<RuntimeMobileSessionCreateTerminalResult> {
  const {
    owner,
    windowAvailable,
    worktreeId,
    opts,
    startupCommand,
    afterDesktopTabId,
    createOwned,
    setDestinationCurrent,
    setTargetGroup,
    wasDispatched
  } = args
  opts.switchExecution!.check()
  const identity = { tabId: randomUUID(), leafId: randomUUID() }
  const pane = { worktreeId, ...identity, operationId: opts.clientMutationId }
  const paneKey = `${identity.tabId}:${identity.leafId}`
  const running = trackRunningAgentLaunchPane({ worktreeId, paneKey })
  setDestinationCurrent(() => {
    if (!running.current()) {
      throw new Error('tab_not_found')
    }
  })
  let shown: AgentLaunchTabPublished | undefined
  let publicationOwner: 'main' | 'window' = 'window'
  const physicalOwners = new Set<Promise<unknown>>()
  const trackPhysical: NonNullable<AgentSessionSwitchAuthority['trackPhysical']> = (
    work,
    recover
  ) => {
    // Recovery-bearing work is the receiver settlement, independent of acquisition observation.
    if (recover) {
      physicalOwners.add(work)
      void work.then(() => physicalOwners.delete(work)).catch(() => {})
    }
    return opts.switchExecution!.trackPhysical?.(work, recover) ?? work
  }
  const withdrawUnused = async () => {
    if (shown?.created !== true || !running.current() || owner.hasLiveTerminalForPaneKey(paneKey)) {
      return
    }
    const withdrawn = await owner.withdrawAgentLaunchPaneInMainLayout(
      pane,
      running.current,
      shown.withdrawalRoot,
      publicationOwner
    )
    if (withdrawn && running.current()) {
      owner.reportAgentLaunchPaneVerdict(pane, { kind: 'withdrawn' })
    }
  }
  try {
    const request = {
      ...pane,
      launchAgent: startupCommand.launchAgent ?? 'codex',
      viewMode: 'terminal' as const,
      viewer:
        (opts.switchExecution!.selectionCurrent?.() ?? true)
          ? opts.switchExecution!.viewer
          : ('none' as const),
      viewerSelection: opts.switchExecution!.viewerSelection,
      placement: {
        afterTabId: opts.switchExecution!.afterTabId ?? afterDesktopTabId,
        groupId: opts.targetGroupId
      },
      operationId: opts.clientMutationId
    }
    const mainPublication =
      ORCA_LAYOUT_OWNER_IS_MAIN || !windowAvailable()
        ? owner.publishAgentLaunchTabInMainLayout(
            request,
            opts.switchExecution!.check,
            opts.switchExecution!.selectionCurrent
          )
        : null
    publicationOwner = mainPublication ? 'main' : 'window'
    const publishing = mainPublication ?? owner.publishAgentLaunchTab(request)
    if (!publishing) {
      throw new Error('runtime_unavailable')
    }
    shown = await publishing
    setTargetGroup(shown.placement.groupId)
    opts.switchExecution!.check()
    if (!running.current()) {
      throw new Error('tab_not_found')
    }
    const result = await createOwned(identity, trackPhysical)
    running.agentBound()
    running.finish({ kind: 'proceed' })
    owner.reportAgentLaunchPaneVerdict(pane, { kind: 'proceed' })
    return result
  } catch (error) {
    const live = owner.hasLiveTerminalForPaneKey(paneKey)
    const withdraw =
      shown?.created === true && running.current() && !live && physicalOwners.size === 0
    const verdict: AgentLaunchPaneVerdict = withdraw
      ? { kind: 'withdrawn' }
      : wasDispatched() && !live
        ? { kind: 'unconfirmed' }
        : { kind: 'proceed' }
    running.finish(verdict)
    if (withdraw) {
      await withdrawUnused()
    } else if (running.current() || live) {
      owner.reportAgentLaunchPaneVerdict(pane, verdict)
    }
    if (physicalOwners.size > 0) {
      // The receiver's real completion, not this observer's error, permits unused cleanup.
      void Promise.all(physicalOwners)
        .then(withdrawUnused)
        .catch(() => {})
    }
    throw error
  }
}
