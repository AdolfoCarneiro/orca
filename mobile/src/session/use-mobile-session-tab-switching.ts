import { useCallback } from 'react'
import { STARTUP_CWD_FALLBACK_SENTENCE } from '../../../src/shared/startup-cwd-fallback'
import { triggerSelection } from '../platform/haptics'
import type { RpcResponse } from '../transport/types'
import { isCachedActiveDocumentRetap } from './mobile-session-active-document-retap'
import { activateMobileSessionTab } from './mobile-session-tab-activation'
import { activatedAtWorkspaceRoot } from './session-write-reply-schema'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionKeyboardStateModel } from './use-mobile-session-keyboard-state'

export function useMobileSessionTabSwitching(scope: MobileSessionKeyboardStateModel) {
  const {
    worktreeId,
    client,
    sessionTabs,
    defaultTerminalHandlesToLiveInput,
    setActiveHandle,
    setActiveSessionTabId,
    activeSessionTabId,
    markdownDocs,
    fileDocs,
    terminalUnsubsRef,
    terminalDiagnosticsRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingSelectionRef,
    switchSessionTabRef,
    unsubscribeTerminal,
    subscribeToTerminal,
    readMarkdownTab,
    readFileTab,
    showToast
  } = scope
  const reportActivation = useCallback(
    (response: RpcResponse) => {
      if (response.ok && activatedAtWorkspaceRoot(response.result)) {
        showToast(STARTUP_CWD_FALLBACK_SENTENCE, 1800)
      }
    },
    [showToast]
  )
  const activateTab = useCallback(
    (tabId: string) =>
      client
        ? activateMobileSessionTab(client, {
            worktree: `id:${worktreeId}`,
            tabId,
            notifyClients: false,
            navigation: 'caller',
            intent: 'user'
          })
            .then((response) => {
              reportActivation(response)
              return response.ok
            })
            .catch(() => false)
        : Promise.resolve(false),
    [client, worktreeId, reportActivation]
  )
  // Why: unsubscribe restores old dims (clears phone-fit banner); resubscribe phone-fits the new one.
  const switchTab = useCallback(
    (handle: string) => {
      triggerSelection()
      const matchingTab = sessionTabs.find(
        (tab): tab is Extract<MobileSessionTab, { type: 'terminal' }> =>
          tab.type === 'terminal' && tab.terminal === handle
      )
      terminalDiagnosticsRef.current.tabSwitch('terminal', matchingTab?.id ?? '', false, handle)
      pendingSelectionRef.current = { kind: 'terminal', handle, tabId: matchingTab?.id ?? null }
      activeSessionTabTypeRef.current = 'terminal'
      defaultTerminalHandlesToLiveInput([handle])
      setActiveSessionTabId(matchingTab?.id ?? null)
      const prev = activeHandleRef.current
      activeHandleRef.current = handle
      setActiveHandle(handle)
      if (prev && prev !== handle) {
        unsubscribeTerminal(prev)
      }
      if (terminalUnsubsRef.current.has(handle)) {
        unsubscribeTerminal(handle)
      }
      subscribeToTerminal(handle)
      return matchingTab ? activateTab(matchingTab.id) : Promise.resolve(false)
    },
    [
      activateTab,
      defaultTerminalHandlesToLiveInput,
      reportActivation,
      sessionTabs,
      subscribeToTerminal,
      unsubscribeTerminal,
      worktreeId
    ]
  )

  const switchSessionTab = useCallback(
    (tab: MobileSessionTab) => {
      if (isCachedActiveDocumentRetap(tab, activeSessionTabId, { markdownDocs, fileDocs })) {
        return
      }
      if (tab.type === 'terminal') {
        if (typeof tab.terminal === 'string') {
          return switchTab(tab.terminal)
        }
        terminalDiagnosticsRef.current.tabSwitch('terminal', tab.id, true)
        triggerSelection()
        pendingSelectionRef.current = { kind: 'tab', tabId: tab.id }
        activeSessionTabTypeRef.current = 'terminal'
        setActiveSessionTabId(tab.id)
        const prev = activeHandleRef.current
        if (prev) {
          unsubscribeTerminal(prev)
        }
        activeHandleRef.current = null
        setActiveHandle(null)
        return activateTab(tab.id)
      }

      triggerSelection()
      terminalDiagnosticsRef.current.tabSwitch(tab.type, tab.id, false)
      pendingSelectionRef.current = { kind: 'tab', tabId: tab.id }
      activeSessionTabTypeRef.current = tab.type
      setActiveSessionTabId(tab.id)
      const prev = activeHandleRef.current
      if (prev) {
        unsubscribeTerminal(prev)
      }
      activeHandleRef.current = null
      setActiveHandle(null)
      const activation = activateTab(tab.id)
      if (tab.type === 'browser') {
        return activation
      }
      if (tab.type === 'file') {
        void readFileTab(tab)
        return activation
      }
      if (tab.type === 'agent-session') {
        return activation
      }
      const cached = markdownDocs.get(tab.id)
      if (cached?.status === 'ready' && cached.isDirty) {
        return activation
      }
      // Revisit rereads clean desktop saves because tab snapshots lack a reliable document version; preserve phone drafts.
      void readMarkdownTab(tab)
      return activation
    },
    [
      activeSessionTabId,
      activateTab,
      fileDocs,
      markdownDocs,
      readFileTab,
      readMarkdownTab,
      reportActivation,
      switchTab,
      unsubscribeTerminal,
      worktreeId
    ]
  )
  switchSessionTabRef.current = switchSessionTab
  return {
    switchTab,
    switchSessionTab
  }
}

export type MobileSessionTabSwitchingModel = MobileSessionKeyboardStateModel &
  ReturnType<typeof useMobileSessionTabSwitching>
