import type { PluginInstallSource } from '../../../shared/plugins/plugin-install-lockfile'
import {
  isOfficialMarketplaceGitSource,
  isOfficialOrganizationGitSource,
  isOfficialPluginIdentity,
  isReservedPluginIdentity
} from '../../../shared/plugins/catalog/plugin-marketplace'

export function pluginInstallTrustError(
  pluginKey: string,
  source: PluginInstallSource
): string | null {
  if (source.kind === 'bundled') {
    return source.bundleId === pluginKey && isOfficialPluginIdentity(pluginKey)
      ? null
      : 'bundled plugins must use an official stablyai.orca-* identity'
  }
  if (!isReservedPluginIdentity(pluginKey)) {
    return null
  }
  // Why the catalog and not the repository: a direct Git URL or another catalog could point
  // at any stablyai repository, including one never meant to ship.
  return source.kind === 'marketplace' &&
    isOfficialMarketplaceGitSource(source.marketplace.url) &&
    isOfficialOrganizationGitSource(source.plugin.url)
    ? null
    : `${pluginKey} uses a name reserved for official Orca plugins; Orca installs it only from its official catalog`
}
