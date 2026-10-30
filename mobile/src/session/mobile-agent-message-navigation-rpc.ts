import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcMethodName } from '../transport/rpc-params-contract'

function senderRead<Method extends RpcMethodName, Schema extends z.ZodType>(
  method: Method,
  schema: Schema
) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name: `chat.sender:${method}`,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: rpcResultVariant('sender', schema)
    })
  )
}
export const locationRead = senderRead(
  'orchestration.partyLocation',
  z.object({
    location: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('chat'), sessionId: z.string(), worktreeId: z.string() }),
        z.object({ kind: z.literal('terminal'), handle: z.string() })
      ])
      .nullable(),
    lost: z.enum(['chat', 'terminal']).optional()
  })
)
export const terminalRead = senderRead(
  'terminal.focus',
  z.object({ focus: z.object({ worktreeId: z.string() }) })
)
const refusal = z.object({ ok: z.literal(false), refusal: z.object({ code: z.string() }) })
export const chatRead = senderRead(
  'agentSession.reveal',
  z.union([
    z.object({
      ok: z.literal(true),
      sessionId: z.string(),
      workspaceId: z.string(),
      agent: z.string(),
      readable: z.boolean()
    }),
    refusal
  ])
)
const tabSchema = z.object({
  type: z.string(),
  id: z.string(),
  sessionId: z.string().optional(),
  terminal: z.string().nullable().optional(),
  parentTabId: z.string().optional(),
  leafId: z.string().optional()
})
export const tabsRead = senderRead('session.tabs.list', z.object({ tabs: z.array(tabSchema) }))
export const allRead = senderRead(
  'session.tabs.listAll',
  z.object({ snapshots: z.array(z.object({ worktree: z.string(), tabs: z.array(tabSchema) })) })
)
