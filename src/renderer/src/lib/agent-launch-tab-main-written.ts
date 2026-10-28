import { conversationSwitchViewerSelectionCurrent } from '@/lib/conversation-switch-selection'
import { agentLaunchPaneAttemptCurrent } from './agent-launch-pane-start'
import { afterLayoutFrame, layoutFramesFlowing } from '@/runtime/layout-frame-position'
import type { AgentLaunchPaneVerdictEvent } from '../../../shared/agent-launch-pane-verdict'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishRequest
} from '../../../shared/agent-launch-tab-publication'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '../store'
import { presentAgentLaunchTab } from './agent-launch-tab-presentation'
import {
  forgetAgentLaunchPanePrompt,
  rememberAgentLaunchPanePrompt
} from './agent-launch-pane-prompt'
import { revealWorkspaceSurface } from './workspace-surface-reveal'
import { layoutFrameTerminalTab } from '@/runtime/layout-frame-terminal-panes'

/** Main owns tab creation/closure; attach this window’s session-only prompt, pane verdict and presentation state when its frame draws, retaining them for undrawn workspaces. */

type LaunchPane = NonNullable<TerminalTab['agentLaunchPane']>

const undrawn = new Map<string, { pane: LaunchPane; present: () => void; stop: () => void }>()

const MAX_MAIN_WRITTEN_TABS = 32
const mainWritten = new Set<string>()

function noteMainWritten(tabId: string): void {
  mainWritten.delete(tabId)
  mainWritten.add(tabId)
  for (const oldest of mainWritten) {
    if (mainWritten.size <= MAX_MAIN_WRITTEN_TABS) {
      break
    }
    mainWritten.delete(oldest)
  }
}

/** The launch settled or was taken back: true when main wrote its tab, so main closes it. */
export function releaseMainWrittenLaunchTab(tabId: string): boolean {
  return mainWritten.delete(tabId)
}

function dropUndrawn(tabId: string): void {
  undrawn.get(tabId)?.stop()
  undrawn.delete(tabId)
  mainWritten.delete(tabId)
  forgetAgentLaunchPanePrompt(tabId)
}

function drawnTab(worktreeId: string, tabId: string): TerminalTab | undefined {
  return useAppStore.getState().tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
}

function launchPaneOf(request: AgentLaunchTabPublishRequest): LaunchPane {
  return {
    leafId: request.leafId,
    ...(request.operationId ? { operationId: request.operationId } : {})
  }
}

/** As for a tab this window made: a retry of the same launch keeps what the tab says about it. */
function keepLaunchPane(tabId: string, kept: TerminalTab, pane: LaunchPane): void {
  const previous = kept.agentLaunchPane
  if (previous?.leafId === pane.leafId && previous.operationId === pane.operationId) {
    return
  }
  useAppStore.getState().setTabAgentLaunchPane(tabId, pane, {
    remount: previous?.leafId === pane.leafId && previous.outcome !== undefined
  })
}

/** Main closed the tab before this window drew it: it never will. */
function goneFromFrames(worktreeId: string, tabId: string): boolean {
  return layoutFramesFlowing() && !layoutFrameTerminalTab(worktreeId, tabId)
}

function keepWhenDrawn(request: AgentLaunchTabPublishRequest, present: () => void): boolean {
  const { worktreeId, tabId } = request
  undrawn.get(tabId)?.stop()

  const forgetIfGone = () => {
    if (
      undrawn.get(tabId)?.pane.operationId === request.operationId &&
      goneFromFrames(worktreeId, tabId)
    ) {
      dropUndrawn(tabId)
    }
  }
  const stop = useAppStore.subscribe(() => {
    const tab = drawnTab(worktreeId, tabId)
    if (!tab) {
      afterLayoutFrame(request.shownByMain?.frameSeq, forgetIfGone)
      return
    }
    const entry = undrawn.get(tabId)
    undrawn.delete(tabId)
    stop()
    if (entry && agentLaunchPaneAttemptCurrent(tabId, entry.pane.leafId, entry.pane.operationId)) {
      keepLaunchPane(tabId, tab, entry.pane)
      entry.present()
    }
  })
  undrawn.set(tabId, { pane: launchPaneOf(request), present, stop })
  if (request.shownByMain) {
    afterLayoutFrame(request.shownByMain.frameSeq, forgetIfGone)
  }
  return undrawn.has(tabId)
}

export function keepAgentLaunchTabMainWrote(
  request: AgentLaunchTabPublishRequest
): AgentLaunchTabPublished {
  const { worktreeId, tabId, leafId, viewer } = request
  if (!agentLaunchPaneAttemptCurrent(tabId, leafId, request.operationId)) {
    throw new Error('agent_launch_superseded')
  }
  const created = request.shownByMain?.created === true
  noteMainWritten(tabId)
  if (request.prompt) {
    rememberAgentLaunchPanePrompt(tabId, request.prompt)
  }
  // Only the launch that made the tab moves anyone, as the window's own publication.
  const present = (): void => {
    if (created) {
      presentAgentLaunchTab(viewer, worktreeId, tabId, leafId, request.viewerSelection)
    }
  }
  const tab = drawnTab(worktreeId, tabId)
  if (tab) {
    keepLaunchPane(tabId, tab, launchPaneOf(request))
    present()
  } else if (
    created &&
    viewer === 'focus-window' &&
    conversationSwitchViewerSelectionCurrent(request.viewerSelection)
  ) {
    // Reveal the workspace while awaiting its tab frame, unless main already closed the tab.
    if (keepWhenDrawn(request, present)) {
      if (request.viewerSelection === undefined) {
        revealWorkspaceSurface(useAppStore.getState(), worktreeId, [tabId])
      }
    }
  } else {
    // Nobody is moved to an undrawn workspace; its tab keeps the launch when it draws.
    keepWhenDrawn(request, present)
  }
  const groupId =
    useAppStore
      .getState()
      .unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.entityId === tabId)?.groupId ?? ''
  return { tabId, created, placement: { groupId } }
}

/** Retain verdicts for undrawn launch panes; return false when no such pane is pending. */
export function applyVerdictToUndrawnLaunchTab(event: AgentLaunchPaneVerdictEvent): boolean {
  if (!agentLaunchPaneAttemptCurrent(event.tabId, event.leafId, event.operationId)) {
    return false
  }
  const entry = undrawn.get(event.tabId)
  if (entry?.pane.leafId !== event.leafId || entry.pane.operationId !== event.operationId) {
    return false
  }
  const { verdict } = event
  if (verdict.kind === 'not-started' || verdict.kind === 'unconfirmed') {
    entry.pane = { ...entry.pane, outcome: verdict }
    return true
  }
  dropUndrawn(event.tabId)
  return true
}

export function _resetUndrawnLaunchTabsForTests(): void {
  for (const entry of undrawn.values()) {
    entry.stop()
  }
  undrawn.clear()
  mainWritten.clear()
}
