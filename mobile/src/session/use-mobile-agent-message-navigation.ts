import {
  locationRead,
  terminalRead,
  chatRead,
  tabsRead,
  allRead
} from './mobile-agent-message-navigation-rpc'
import { useCallback, useRef } from 'react'
import { useFocusEffect } from 'expo-router'
import type { AgentMessageSource } from '../../../src/shared/agent-session/agent-session-message-source'
import { structuredAgentSessionPaneKey } from '../../../src/shared/structured-agent-session-projection'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { RpcIncompatibleReplyError } from '../transport/rpc-incompatible-reply-error'
import { mobileSenderOpenFailure } from './mobile-agent-message-open-outcome'
import type { MobileSessionKeyboardStateModel } from './use-mobile-session-keyboard-state'

const unavailableCodes = new Set([
  'forbidden',
  'method_not_found',
  'method_not_supported',
  'unsupported_method'
])
class SenderRefusal extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
class SenderOutcome extends Error {
  constructor(readonly outcome: 'chat' | 'terminal' | 'unreachable' | 'unsupported') {
    super(outcome)
  }
}
const superseded = Symbol('superseded')

export function useMobileAgentMessageNavigation(
  client: RpcClient | null,
  navigate: (worktreeId: string, paneKey: string) => void,
  sourceKey: string,
  showToast: (message: string, duration?: number) => void,
  {
    activeSessionTabIdRef,
    selectedSessionTabIdRef,
    sessionTabsRef,
    pendingSelectionRef
  }: Pick<
    MobileSessionKeyboardStateModel,
    'activeSessionTabIdRef' | 'selectedSessionTabIdRef' | 'sessionTabsRef' | 'pendingSelectionRef'
  >
) {
  const scope = useRef<{ active: boolean; attempt?: { key: string }; client: RpcClient | null }>({
    active: false,
    client
  })
  useFocusEffect(
    useCallback(() => {
      const visit = { active: true, client }
      scope.current = visit
      return () => {
        visit.active = false
      }
    }, [client, navigate, sourceKey])
  )
  return useCallback(
    (from: AgentMessageSource, sender: AgentMessageSource['senders'][number]) => {
      const visit = scope.current
      if (!visit.active) {
        return
      }
      const requestClient = visit.client
      const generation = requestClient?.getGeneration?.()
      const messageIds =
        from.orchestration?.message === 'mail-notice'
          ? from.orchestration.messages
              .filter((message) => message.from === sender.party.address)
              .map((message) => message.messageId)
          : []
      const key = JSON.stringify([
        generation,
        sender.party.address,
        sender.party.orcaSessionId,
        sender.party.terminalHandle,
        messageIds
      ])
      if (visit.attempt?.key === key) {
        return
      }
      const sourceId = activeSessionTabIdRef.current
      if (
        !pendingSelectionRef.current &&
        sourceId &&
        sessionTabsRef.current.some((tab) => tab.id === sourceId)
      ) {
        selectedSessionTabIdRef.current = sourceId
      }
      const attempt = { key }
      visit.attempt = attempt
      const deadline = Date.now() + 15_000
      const current = () =>
        visit.active &&
        scope.current === visit &&
        visit.attempt === attempt &&
        requestClient?.getGeneration?.() === generation
      const check = () => {
        if (!current()) {
          throw superseded
        }
        if (Date.now() >= deadline) {
          throw new SenderOutcome('unreachable')
        }
      }
      async function stage<T>(
        request: (options: SendRequestOptions) => Promise<RpcResponse>,
        read: (response: RpcResponse) => T
      ): Promise<T> {
        check()
        const response = await request({
          timeoutMs: Math.min(5_000, deadline - Date.now()),
          budgetSpansConnect: true
        })
        check()
        if (!response.ok) {
          throw new SenderRefusal(response.error.code)
        }
        return read(response)
      }
      void (async () => {
        if (!requestClient) {
          throw new SenderOutcome('unreachable')
        }
        const inventoryChat = async (sessionId: string) => {
          const inventory = await stage(
            (options) => allRead.request(requestClient, undefined, options),
            allRead.interpret
          )
          for (const snapshot of inventory.snapshots) {
            const tab = snapshot.tabs.find(
              (tab) => tab.type === 'agent-session' && tab.sessionId === sessionId
            )
            if (tab) {
              return {
                worktreeId: snapshot.worktree,
                paneKey: structuredAgentSessionPaneKey(tab.id, sessionId)
              }
            }
          }
          throw new SenderOutcome('unsupported')
        }
        const openTerminal = async (handle: string) => {
          const { focus } = await stage(
            (options) =>
              terminalRead.request(
                requestClient,
                { terminal: handle, navigation: 'caller' },
                options
              ),
            terminalRead.interpret
          )
          const { tabs } = await stage(
            (options) =>
              tabsRead.request(requestClient, { worktree: `id:${focus.worktreeId}` }, options),
            tabsRead.interpret
          )
          const tab = tabs.find((tab) => tab.type === 'terminal' && tab.terminal === handle)
          if (!tab?.leafId) {
            throw new SenderOutcome('unreachable')
          }
          return {
            worktreeId: focus.worktreeId,
            paneKey: `${tab.parentTabId ?? tab.id}:${tab.leafId}`
          }
        }
        const resolve = async () => {
          let located
          try {
            located = await stage(
              (options) =>
                locationRead.request(
                  requestClient,
                  { address: sender.party.address, messageIds },
                  options
                ),
              locationRead.interpret
            )
          } catch (error) {
            if (!(error instanceof SenderRefusal) || !unavailableCodes.has(error.code)) {
              throw error
            }
            if (sender.party.orcaSessionId) {
              return inventoryChat(sender.party.orcaSessionId)
            }
            if (sender.party.terminalHandle) {
              return openTerminal(sender.party.terminalHandle)
            }
            throw new SenderOutcome('unsupported')
          }
          if (!located.location) {
            throw new SenderOutcome(located.lost ?? 'unreachable')
          }
          const location = located.location
          if (location.kind === 'terminal') {
            return openTerminal(location.handle)
          }
          try {
            const revealed = await stage(
              (options) =>
                chatRead.request(
                  requestClient,
                  { sessionId: location.sessionId, navigation: 'caller' },
                  options
                ),
              chatRead.interpret
            )
            if (!revealed.ok) {
              throw new SenderRefusal(revealed.refusal.code)
            }
            const { tabs } = await stage(
              (options) =>
                tabsRead.request(
                  requestClient,
                  { worktree: `id:${revealed.workspaceId}` },
                  options
                ),
              tabsRead.interpret
            )
            const tab = tabs.find(
              (tab) => tab.type === 'agent-session' && tab.sessionId === revealed.sessionId
            )
            if (!tab) {
              throw new SenderOutcome('unreachable')
            }
            return {
              worktreeId: revealed.workspaceId,
              paneKey: structuredAgentSessionPaneKey(tab.id, revealed.sessionId)
            }
          } catch (error) {
            if (
              !(error instanceof SenderRefusal) ||
              !(unavailableCodes.has(error.code) || error.code === 'invalid_argument')
            ) {
              throw error
            }
            return inventoryChat(location.sessionId)
          }
        }
        const destination = await resolve()
        check()
        navigate(destination.worktreeId, destination.paneKey)
      })()
        .catch((error: unknown) => {
          if (!current()) {
            return
          }
          const outcome =
            error instanceof SenderOutcome
              ? error.outcome
              : error instanceof RpcIncompatibleReplyError ||
                  (error instanceof SenderRefusal &&
                    (unavailableCodes.has(error.code) ||
                      error.code === 'structured_agent_session_unsupported'))
                ? 'unsupported'
                : error instanceof SenderRefusal && error.code === 'agent_session_identity_required'
                  ? 'chat'
                  : error instanceof SenderRefusal && error.code === 'terminal_exited'
                    ? 'terminal'
                    : 'unreachable'
          showToast(mobileSenderOpenFailure(outcome), 3000)
        })
        .finally(() => {
          if (visit.attempt === attempt) {
            visit.attempt = undefined
          }
        })
    },
    [
      navigate,
      showToast,
      activeSessionTabIdRef,
      selectedSessionTabIdRef,
      sessionTabsRef,
      pendingSelectionRef
    ]
  )
}
