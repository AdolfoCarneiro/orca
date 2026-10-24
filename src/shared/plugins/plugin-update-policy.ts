/** How catalog plugins update. A union, not a boolean, so later policies (e.g. official only)
 *  can be added without migrating the setting. */
export const PLUGIN_UPDATE_POLICIES = ['auto', 'manual'] as const
export type PluginUpdatePolicy = (typeof PLUGIN_UPDATE_POLICIES)[number]

export type PluginUpdatePolicySettings = {
  /** Absent means `auto`: updates that ask for nothing new install on their own. */
  pluginUpdatePolicy?: PluginUpdatePolicy
}

export function isPluginAutoUpdateOn(settings: PluginUpdatePolicySettings): boolean {
  return settings.pluginUpdatePolicy !== 'manual'
}

/** Bounds the policy on every write and load; only a key present in `input` returns. */
export function normalizePluginUpdatePolicySettings(
  input: object
): Partial<PluginUpdatePolicySettings> {
  if (!('pluginUpdatePolicy' in input)) {
    return {}
  }
  const value = input.pluginUpdatePolicy
  return { pluginUpdatePolicy: value === 'manual' ? 'manual' : 'auto' }
}

/** What the last automatic pass did, by plugin key → version. */
export type PluginAutoUpdateState = {
  /** Installed unasked this session. */
  updated: Record<string, string>
  /** Held back because the update asks for more access or moved repository. */
  needsReview: Record<string, string>
}
