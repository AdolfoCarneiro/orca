import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { getCachedTerminalTabForWorktree } from './terminal-tab-lookup'
import { selectTerminalTabAgentTypesByLeaf } from './terminal-tab-agent-type-index'
import { collectLeafIdsInOrder, EMPTY_LAYOUT } from './layout-serialization'
import { sanitizeTerminalLayoutPaneTitles } from '../../../../shared/terminal-pane-title-sanitization'
import { resolveNativeChatLeafTitleAgent } from './native-chat-leaf-title-agent'
import { useTerminalPaneStoreActions } from './use-terminal-pane-store-actions'
import { selectUnifiedTerminalTabFields } from './terminal-unified-tab-lookup'
import {
  canToggleNativeChat,
  nativeChatAvailabilityAgent
} from '../../../../shared/native-chat-availability'
import { isNativeChatSupportedAgent } from '../../../../shared/native-chat-agent-support'
import {
  nativeChatLaunchAgentForLeaf,
  resolveNativeChatLeafRoute,
  type NativeChatLeafRoute
} from '../native-chat/native-chat-leaf-routing'
import type { TerminalPaneTitleController } from './use-terminal-pane-title-state'

export function useTerminalPaneChatState(controller: TerminalPaneTitleController) {
  const {
    chatLeafId,
    managerRef,
    nativeChatIsWslProject,
    nativeChatTranscriptIsLocalReadable,
    onAgentExitedRef,
    paneCount,
    setChatLeafId,
    setTabWideAgentHintLeafId,
    tabId,
    tabWideAgentHintLeafId,
    worktreeId
  } = controller
  const {
    clearCodexRestartNotice,
    consumePendingPaneAccountRestart,
    setTabCanExpandPane,
    setTabLayout,
    setTabPaneExpanded,
    setTabViewMode,
    suppressPtyExit,
    toggleTabViewMode
  } = useTerminalPaneStoreActions()
  // Bundle unified-tab reads to reduce lookups and subscriptions per mounted tab.
  const { unifiedTabId, isChatViewMode, unifiedTabLabel, isTabPinned } = useAppStore(
    useShallow((store) =>
      selectUnifiedTerminalTabFields(store.unifiedTabsByWorktree, worktreeId, tabId)
    )
  )
  const runtimePaneTitlesByPaneId = useAppStore(
    useShallow((store) => store.runtimePaneTitlesByTabId[tabId] ?? {})
  )
  const tabAgentTypeByLeaf = useAppStore((store) =>
    selectTerminalTabAgentTypesByLeaf(
      store.agentStatusByPaneKey,
      tabId,
      store.paneForegroundAgentByPaneKey
    )
  )
  const savedLayout = useAppStore((store) => store.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT)
  const terminalTab = useAppStore((store) =>
    getCachedTerminalTabForWorktree(store.tabsByWorktree, worktreeId, tabId)
  )
  const restoredLayout = useMemo(
    () => (terminalTab ? sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab) : savedLayout),
    [savedLayout, terminalTab]
  )
  const expectedLayoutLeafIds = useMemo(
    () => collectLeafIdsInOrder(restoredLayout.root),
    [restoredLayout.root]
  )
  const getNativeChatLeafIds = useCallback((): string[] => {
    const mountedLeafIds = managerRef.current?.getPanes().map((pane) => pane.leafId) ?? []
    return [...new Set([...expectedLayoutLeafIds, ...mountedLeafIds])]
  }, [expectedLayoutLeafIds, managerRef])
  const getTabWideAgentHintLeafId = useCallback((): string | null => {
    if (tabWideAgentHintLeafId !== undefined) {
      return tabWideAgentHintLeafId
    }
    const leafIds = getNativeChatLeafIds()
    return leafIds.length === 1 ? leafIds[0] : null
  }, [getNativeChatLeafIds, tabWideAgentHintLeafId])
  const getTabWideAgentHintLeafIdRef = useRef(getTabWideAgentHintLeafId)
  useEffect(() => {
    getTabWideAgentHintLeafIdRef.current = getTabWideAgentHintLeafId
  }, [getTabWideAgentHintLeafId])
  useEffect(() => {
    if (tabWideAgentHintLeafId !== undefined) {
      return
    }
    const leafIds = getNativeChatLeafIds()
    if (leafIds.length === 0) {
      return
    }
    setTabWideAgentHintLeafId(leafIds.length === 1 ? leafIds[0] : null)
  }, [getNativeChatLeafIds, paneCount, tabWideAgentHintLeafId, setTabWideAgentHintLeafId])
  const resolveTitleAgentForLeaf = useCallback(
    (leafId: string | null) => {
      const hasSingleKnownLeaf =
        getNativeChatLeafIds().length === 1 && getTabWideAgentHintLeafId() === leafId
      return resolveNativeChatLeafTitleAgent({
        leafId,
        panes: managerRef.current?.getPanes() ?? [],
        runtimePaneTitlesByPaneId,
        tabLabel: hasSingleKnownLeaf ? unifiedTabLabel : null,
        terminalTitle: hasSingleKnownLeaf ? terminalTab?.title : null
      })
    },
    [
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      runtimePaneTitlesByPaneId,
      terminalTab?.title,
      unifiedTabLabel,
      managerRef
    ]
  )
  const agentEvidenceForLeaf = useCallback(
    (leafId: string | null) => {
      const detectedAgent = leafId ? (tabAgentTypeByLeaf[leafId] ?? null) : null
      const launchAgent = nativeChatLaunchAgentForLeaf({
        launchAgent: terminalTab?.launchAgent,
        launchAgentLeafId: getTabWideAgentHintLeafId(),
        leafId,
        leafIds: getNativeChatLeafIds()
      })
      return {
        launchAgent: detectedAgent ? null : launchAgent,
        detectedAgent,
        resolvedAgent: detectedAgent ? null : resolveTitleAgentForLeaf(leafId)
      }
    },
    [
      tabAgentTypeByLeaf,
      terminalTab?.launchAgent,
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      resolveTitleAgentForLeaf
    ]
  )
  const isChatEligibleForLeaf = useCallback(
    (leafId: string | null): boolean =>
      canToggleNativeChat({
        contentType: 'terminal',
        isWslProject: nativeChatIsWslProject,
        ...agentEvidenceForLeaf(leafId),
        nativeChatTranscriptIsLocalReadable
      }),
    [nativeChatIsWslProject, nativeChatTranscriptIsLocalReadable, agentEvidenceForLeaf]
  )
  const chatAgent = nativeChatAvailabilityAgent(agentEvidenceForLeaf(chatLeafId))
  // Reconnect may omit identity; a known unsupported agent must still return to its terminal.
  const chatViewIsSupported =
    nativeChatIsWslProject && (chatAgent === null || isNativeChatSupportedAgent(chatAgent))
  const effectiveChatViewMode = isChatViewMode && chatViewIsSupported
  const applyNativeChatLeafRoute = useCallback(
    (route: NativeChatLeafRoute): void => {
      const state = useAppStore.getState()
      const currentMode = selectUnifiedTerminalTabFields(
        state.unifiedTabsByWorktree,
        worktreeId,
        tabId
      ).isChatViewMode
      if (!isChatViewMode && currentMode && chatLeafId && route.chatLeafId === null) {
        // Keep the owner through the batched toggle that turns chat mode on.
        return
      }
      if (route.chatLeafId !== chatLeafId) {
        setChatLeafId(route.chatLeafId)
      }
      const existingLayout = useAppStore.getState().terminalLayoutsByTabId[tabId]
      if (existingLayout && existingLayout.chatLeafId !== (route.chatLeafId ?? undefined)) {
        if (route.chatLeafId) {
          setTabLayout(tabId, { ...existingLayout, chatLeafId: route.chatLeafId })
        } else if (existingLayout?.chatLeafId) {
          const nextLayout = { ...existingLayout }
          delete nextLayout.chatLeafId
          setTabLayout(tabId, nextLayout)
        }
      }
      if (route.exitChat && unifiedTabId) {
        setTabViewMode(unifiedTabId, 'terminal')
      }
    },
    [
      chatLeafId,
      isChatViewMode,
      setTabLayout,
      setTabViewMode,
      tabId,
      unifiedTabId,
      worktreeId,
      setChatLeafId
    ]
  )
  const handleConfirmedAgentExit = useCallback(
    (leafId: string): void => {
      if (leafId !== chatLeafId) {
        return
      }
      const panes = managerRef.current?.getPanes() ?? []
      const activeLeafId = managerRef.current?.getActivePane()?.leafId ?? null
      applyNativeChatLeafRoute(
        resolveNativeChatLeafRoute({
          isChatViewMode,
          chatViewIsSupported,
          chatLeafId,
          activeLeafId,
          chatLeafStillMounted: panes.some((pane) => pane.leafId === chatLeafId),
          activeLeafIsEligible: isChatEligibleForLeaf(activeLeafId),
          chatLeafHasConfirmedAgentExit: true
        })
      )
    },
    [
      applyNativeChatLeafRoute,
      chatLeafId,
      chatViewIsSupported,
      isChatEligibleForLeaf,
      isChatViewMode,
      managerRef
    ]
  )
  useEffect(() => {
    onAgentExitedRef.current = handleConfirmedAgentExit
  }, [handleConfirmedAgentExit, onAgentExitedRef])
  const canToggleChatForLeaf = useCallback(
    (leafId: string | null): boolean =>
      (effectiveChatViewMode && leafId !== null && chatLeafId === leafId) ||
      isChatEligibleForLeaf(leafId),
    [chatLeafId, effectiveChatViewMode, isChatEligibleForLeaf]
  )
  const toggleNativeChatForLeaf = useCallback(
    (leafId: string) => {
      if (!unifiedTabId) {
        return
      }
      if (effectiveChatViewMode && chatLeafId === leafId) {
        setChatLeafId(null)
        toggleTabViewMode(unifiedTabId)
        return
      }
      setChatLeafId(leafId)
      if (!effectiveChatViewMode) {
        toggleTabViewMode(unifiedTabId)
      }
    },
    [chatLeafId, effectiveChatViewMode, setChatLeafId, toggleTabViewMode, unifiedTabId]
  )
  const handleToggleNativeChat = useCallback(() => {
    const activeLeafId = managerRef.current?.getActivePane()?.leafId ?? null
    if (!activeLeafId) {
      return
    }
    toggleNativeChatForLeaf(activeLeafId)
  }, [toggleNativeChatForLeaf, managerRef])
  const switchNativeChatToTerminal = useCallback(() => {
    if (chatLeafId && unifiedTabId) {
      setChatLeafId(null)
      setTabViewMode(unifiedTabId, 'terminal')
    }
  }, [chatLeafId, setChatLeafId, setTabViewMode, unifiedTabId])
  const readNativeChatTerminalScreen = useCallback((): string | null => {
    const pane = managerRef.current?.getPanes().find((candidate) => candidate.leafId === chatLeafId)
    return pane?.serializeAddon.serialize({ scrollback: 0 }) ?? null
  }, [chatLeafId, managerRef])

  return {
    setTabPaneExpanded,
    setTabCanExpandPane,
    suppressPtyExit,
    consumePendingPaneAccountRestart,
    clearCodexRestartNotice,
    unifiedTabId,
    isChatViewMode,
    effectiveChatViewMode,
    chatViewIsSupported,
    unifiedTabLabel,
    isTabPinned,
    runtimePaneTitlesByPaneId,
    tabAgentTypeByLeaf,
    setTabViewMode,
    savedLayout,
    terminalTab,
    restoredLayout,
    expectedLayoutLeafIds,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    getTabWideAgentHintLeafIdRef,
    resolveTitleAgentForLeaf,
    isChatEligibleForLeaf,
    canToggleChatForLeaf,
    toggleNativeChatForLeaf,
    handleToggleNativeChat,
    applyNativeChatLeafRoute,
    switchNativeChatToTerminal,
    readNativeChatTerminalScreen
  }
}

export type TerminalPaneChatController = TerminalPaneTitleController &
  ReturnType<typeof useTerminalPaneChatState>
