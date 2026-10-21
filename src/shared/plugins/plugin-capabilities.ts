import { z } from 'zod'
import { PLUGIN_ENUM_SINCE_KEY } from './manifest/plugin-engine-floor-keys'
import { pluginFieldDoc, PLUGIN_SCHEMA_SINCE_V1 } from './manifest/plugin-schema-field-docs'

/** Closed v0 capabilities fail unknown kinds instead of silently granting nothing. Consent binds capabilities and worker trust;
 * host boundaries enforce them across desktop, headless serve and relay. Scoped kinds remain future work. */

export const PLUGIN_CAPABILITY_KINDS = [
  'workspace:read',
  'terminal:send',
  'notifications:show',
  'storage',
  'secrets',
  'events:subscribe',
  'settings:own'
] as const

export type PluginCapabilityKind = (typeof PLUGIN_CAPABILITY_KINDS)[number]

/** The release each capability arrived in; engines.orca must cover every one a plugin asks for. */
export const PLUGIN_CAPABILITY_SINCE: Record<PluginCapabilityKind, string> = {
  'workspace:read': PLUGIN_SCHEMA_SINCE_V1,
  'terminal:send': PLUGIN_SCHEMA_SINCE_V1,
  'notifications:show': PLUGIN_SCHEMA_SINCE_V1,
  storage: PLUGIN_SCHEMA_SINCE_V1,
  secrets: PLUGIN_SCHEMA_SINCE_V1,
  'events:subscribe': PLUGIN_SCHEMA_SINCE_V1,
  'settings:own': PLUGIN_SCHEMA_SINCE_V1
}

// Strict object (not a bare enum) so scoped fields can be added per-kind later
// without changing the manifest shape.
export const pluginCapabilitySchema = z
  .object({
    kind: z.enum(PLUGIN_CAPABILITY_KINDS).meta({
      ...pluginFieldDoc('Capability granted on user consent.', PLUGIN_SCHEMA_SINCE_V1),
      [PLUGIN_ENUM_SINCE_KEY]: PLUGIN_CAPABILITY_SINCE
    })
  })
  .strict()
  .meta({ id: 'Capability', description: 'A host API the plugin may call once the user consents.' })

export type PluginCapability = z.infer<typeof pluginCapabilitySchema>

/** Consent copy shown verbatim; describe only what the host actually enforces. */
export const PLUGIN_CAPABILITY_DESCRIPTIONS: Record<PluginCapabilityKind, string> = {
  'workspace:read': 'Read the name, branch, and terminal list of your focused worktree',
  'terminal:send': 'Type text into a terminal you can see (always a specific terminal)',
  'notifications:show': 'Show desktop notifications labeled with the plugin name',
  storage: "Store data in the plugin's own storage folder",
  secrets: "Store and read secrets in the plugin's own encrypted vault",
  'events:subscribe':
    'Get notified when worktrees are created or removed and when agent status changes',
  'settings:own': "Read and change the plugin's own settings"
}

/** Canonicalize order, duplicates and field order so equivalent grants preserve consent across manifest formatting changes. */
export function canonicalizeCapabilitySet(capabilities: readonly PluginCapability[]): string {
  const encoded = capabilities.map((capability) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(capability).sort(([a], [b]) => a.localeCompare(b)))
    )
  )
  return JSON.stringify([...new Set(encoded)].sort())
}

export function capabilityKinds(capabilities: readonly PluginCapability[]): PluginCapabilityKind[] {
  return [...new Set(capabilities.map((capability) => capability.kind))]
}
