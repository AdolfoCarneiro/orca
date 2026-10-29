import { useCallback, useEffect, useRef } from 'react'
import { z } from 'zod'
import type { AgentMessageSource } from '../../../src/shared/agent-session/agent-session-message-source'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc-client'
import { sessionTabsListRead } from './mobile-session-read-operations'

const senderLocation = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'chat.sender-location',
    method: 'orchestration.partyLocation',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'sender-location',
      z.object({
        location: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('chat'), sessionId: z.string(), worktreeId: z.string() }),
            z.object({ kind: z.literal('terminal'), handle: z.string() })
          ])
          .nullable()
      })
    )
  })
)
const senderTerminal = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'chat.sender-terminal',
    method: 'terminal.focus',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'sender-terminal',
      z.object({ focus: z.object({ worktreeId: z.string() }) })
    )
  })
)
const senderChat = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'chat.sender-chat',
    method: 'agentSession.reveal',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sender-chat', z.object({ ok: z.literal(true) }))
  })
)
const terminalTabs = z.object({
  tabs: z.array(
    z.object({
      type: z.string(),
      terminal: z.string().nullable().optional(),
      id: z.string(),
      parentTabId: z.string().optional(),
      leafId: z.string().optional()
    })
  )
})

export function useMobileAgentMessageNavigation(
  client: RpcClient | null,
  navigate: (worktreeId: string, paneKey: string) => void
) {
  const scope = useRef({ client, navigate, active: true, pending: new Set<string>() })
  useEffect(() => {
    const current = { client, navigate, active: true, pending: new Set<string>() }
    scope.current = current
    return () => {
      current.active = false
    }
  }, [client, navigate])
  return useCallback((from: AgentMessageSource, sender: AgentMessageSource['senders'][number]) => {
    const current = scope.current
    const requestClient = current.client
    if (!requestClient || !current.active || current.pending.has(sender.party.address)) {
      return
    }
    current.pending.add(sender.party.address)
    void (async () => {
      const messageIds =
        from.orchestration?.message === 'mail-notice'
          ? from.orchestration.messages
              .filter((message) => message.from === sender.party.address)
              .map((message) => message.messageId)
          : []
      const { location } = senderLocation.interpret(
        await senderLocation.request(requestClient, { address: sender.party.address, messageIds })
      )
      if (!location || !current.active) {
        return
      }
      let worktreeId: string, paneKey: string
      if (location.kind === 'chat') {
        senderChat.interpret(
          await senderChat.request(requestClient, { sessionId: location.sessionId })
        )
        worktreeId = location.worktreeId
        paneKey = structuredAgentSessionPaneKey(
          structuredAgentSessionTabId(location.sessionId),
          location.sessionId
        )
      } else {
        const { focus } = senderTerminal.interpret(
          await senderTerminal.request(requestClient, {
            terminal: location.handle,
            navigation: 'caller'
          })
        )
        worktreeId = focus.worktreeId
        const tabs = terminalTabs.parse(
          sessionTabsListRead.interpret(
            await sessionTabsListRead.request(requestClient, { worktree: `id:${worktreeId}` })
          )
        ).tabs
        const tab = tabs.find((tab) => tab.type === 'terminal' && tab.terminal === location.handle)
        if (!tab?.leafId) {
          return
        }
        paneKey = `${tab.parentTabId ?? tab.id}:${tab.leafId}`
      }
      if (current.active) {
        current.navigate(worktreeId, paneKey)
      }
    })()
      .catch(() => {})
      .finally(() => current.pending.delete(sender.party.address))
  }, [])
}
