import { z } from 'zod'
import type { PluginEventName } from './manifest/plugin-manifest'

/**
 * Payload contracts for the v0 plugin event set (workspace lifecycle + agent
 * status only). Payloads are bounded projections — never raw runtime
 * objects — so nothing sensitive (absolute repo paths beyond the worktree's
 * own, remotes, credentials) can leak through the event stream.
 */

const workspaceIdentity = {
  workspaceId: z.string().min(1).max(2048),
  /** Folder workspaces have no branch; only worktrees emit lifecycle events today. */
  kind: z.enum(['worktree', 'folder'])
}

export const workspaceCreatedPayloadSchema = z.object({
  ...workspaceIdentity,
  path: z
    .string()
    .min(1)
    .max(32 * 1024),
  branch: z.string().max(1024)
})

export const workspaceRemovedPayloadSchema = z.object({
  ...workspaceIdentity,
  path: z
    .string()
    .min(1)
    .max(32 * 1024)
})

export const agentStatusChangedPayloadSchema = z.object({
  workspaceId: z.string().min(1).max(2048).nullable(),
  paneKey: z.string().min(1).max(2048),
  /** The combined status the user sees: `working` while the main agent or any live child works. */
  state: z.string().min(1).max(256),
  receivedAt: z.number().finite().positive(),
  /** Distinguish the main agent from combined child activity; absent on older hosts or without main-agent evidence. State keeps its meaning. */
  mainAgent: z
    .object({
      state: z.string().min(1).max(256),
      /** The verdict on the main agent's last finished turn, the provider's or else the host-observed end
       *  (`interruption`, `unconfirmed`); present only while `state` is done. */
      outcome: z.string().min(1).max(256).optional(),
      // Why: the same bound the row normalizer applies; a stricter one here would reject the whole event.
      /** Stamped by the host the agent runs on (an SSH host's own clock), unlike `receivedAt`. */
      stateStartedAt: z.number().finite()
    })
    .optional()
})

export const PLUGIN_EVENT_PAYLOAD_SCHEMAS: Record<PluginEventName, z.ZodTypeAny> = {
  'workspace.created': workspaceCreatedPayloadSchema,
  'workspace.removed': workspaceRemovedPayloadSchema,
  'agent.status.changed': agentStatusChangedPayloadSchema
}

export type PluginWorkspaceCreatedPayload = z.infer<typeof workspaceCreatedPayloadSchema>
export type PluginWorkspaceRemovedPayload = z.infer<typeof workspaceRemovedPayloadSchema>
export type PluginAgentStatusChangedPayload = z.infer<typeof agentStatusChangedPayloadSchema>
