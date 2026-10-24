import {
  getPluginActivationState,
  type PluginActivationState,
  type PluginConsentLists
} from '../../shared/plugins/approval/plugin-consent-state'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginServiceOptions } from './plugin-service-options'
import { pluginExecutionProfile } from '../../shared/plugins/plugin-execution-profile'

export const PLUGIN_FULL_ACCESS_OFF_ERROR =
  'Full access plugins are turned off. Turn on "Allow plugins that run code with full access" in Plugin settings.'

/** Why a second gate: trusted workers are unsandboxed Node, so the system switch alone is not enough. */
export function isFullAccessBlocked(
  plugin: Pick<ValidDiscoveredPlugin, 'manifest'>,
  isFullAccessAllowed: () => boolean
): boolean {
  return pluginExecutionProfile(plugin.manifest) === 'trusted-worker' && !isFullAccessAllowed()
}

export function fullAccessError(
  plugin: Pick<ValidDiscoveredPlugin, 'manifest'> | null,
  isFullAccessAllowed: () => boolean
): string | null {
  return plugin && isFullAccessBlocked(plugin, isFullAccessAllowed)
    ? PLUGIN_FULL_ACCESS_OFF_ERROR
    : null
}

export function snapshotPluginConsentLists(source: {
  getPluginConsents: () => Record<string, string>
  getDisabledPlugins: () => string[]
}): PluginConsentLists {
  return {
    pluginConsents: source.getPluginConsents(),
    disabledPlugins: source.getDisabledPlugins()
  }
}

export function isPluginApproved(
  enabled: boolean,
  plugin: ValidDiscoveredPlugin,
  lists: PluginConsentLists
): boolean {
  return (
    enabled &&
    getPluginActivationState(plugin.pluginKey, plugin.consentFingerprint, lists) === 'approved'
  )
}

/** Live consent state. The feature flag is an authority boundary, not only a discovery hint:
 *  callers fail closed immediately even before async reconciliation ends. */
export function livePluginActivationState(
  source: Pick<
    PluginServiceOptions,
    'isPluginSystemEnabled' | 'getPluginConsents' | 'getDisabledPlugins'
  >,
  plugin: ValidDiscoveredPlugin
): PluginActivationState {
  if (!source.isPluginSystemEnabled()) {
    return 'disabled'
  }
  return getPluginActivationState(
    plugin.pluginKey,
    plugin.consentFingerprint,
    snapshotPluginConsentLists(source)
  )
}
