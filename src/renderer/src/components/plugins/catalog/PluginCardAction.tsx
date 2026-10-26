import { Check, Loader2 } from 'lucide-react'
import { satisfiesOrcaEngineRange } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { StatusWord } from '../list/PluginStatusWord'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { installedPluginControls, type InstalledRowHandlers } from '../list/PluginManagerRows'
import type { PluginInstallPhase } from '../state/use-plugin-install-action'
import { usePluginInUse } from '../state/use-plugin-in-use'
import { PluginInUseAction } from './PluginInUseAction'

export function needsNewerOrca(entry: PluginListEntry, orcaVersion: string | null): string | null {
  return entry.minimumOrca &&
    orcaVersion &&
    !satisfiesOrcaEngineRange(orcaVersion, `>=${entry.minimumOrca}`)
    ? entry.minimumOrca
    : null
}

/** One click installs only what the catalog verifies as content only; anything else is reviewed. */
export function installsInOneClick(entry: PluginListEntry): boolean {
  return entry.listing?.release?.execution === 'data'
}

/** What a catalog card's single action slot offers, by state. */
export function PluginCardAction({
  entry,
  phase,
  orcaVersion,
  onInstall,
  onOpen,
  installedHandlers,
  onOpenFullAccessSetting,
  busy = false,
  refreshing = false
}: {
  entry: PluginListEntry
  refreshing?: boolean
  /** Set when installing needs the full access setting turned on first. */
  onOpenFullAccessSetting?: () => void
  phase: PluginInstallPhase | null
  orcaVersion: string | null
  onInstall: () => void
  onOpen: () => void
  installedHandlers: InstalledRowHandlers
  /** A remove or switch for this plugin is in flight. */
  busy?: boolean
}): React.JSX.Element | null {
  const installed = entry.installed
  const inUse = usePluginInUse(installed ? entry.pluginKey : null)
  if (installed) {
    const controls = installedPluginControls(installed, entry, {
      busy,
      canCheckUpdate: entry.updatable,
      handlers: installedHandlers,
      toggleInMenu: true
    })
    const healthy = controls.kind === 'enabled' || controls.kind === 'running'
    const status =
      controls.action ??
      (!healthy ? (
        controls.status
      ) : inUse ? (
        <PluginInUseAction pluginKey={entry.pluginKey} name={entry.name} inUse={inUse} />
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Check className="size-3.5 text-status-success" aria-hidden="true" />
          {translate('auto.components.settings.PluginCardAction.installed', 'Installed')}
        </span>
      ))
    return (
      <>
        {status}
        {controls.more}
      </>
    )
  }
  if (entry.listing?.blockedByKillList) {
    return <StatusWord kind="blocked" />
  }
  const needsOrca = needsNewerOrca(entry, orcaVersion)
  if (needsOrca) {
    return (
      <span className="text-xs whitespace-nowrap text-status-warning-text">
        {translate(
          'auto.components.settings.PluginManagerRows.needsOrca',
          'Needs Orca {{value0}}',
          {
            value0: needsOrca
          }
        )}
      </span>
    )
  }
  if (onOpenFullAccessSetting) {
    return (
      <Button variant="outline" size="xs" className="w-32" onClick={onOpenFullAccessSetting}>
        {translate(
          'auto.components.settings.PluginCardAction.openFullAccess',
          'Turn on in settings'
        )}
      </Button>
    )
  }
  if (phase?.kind === 'installing') {
    return (
      <Button variant="outline" size="xs" className="w-32" disabled>
        <Loader2 className="animate-spin" />
        {translate('auto.components.settings.PluginCardAction.installing', 'Installing…')}
      </Button>
    )
  }
  if (!installsInOneClick(entry)) {
    return (
      <Button
        variant="outline"
        size="xs"
        className="w-32"
        aria-label={translate(
          'auto.components.settings.PluginCardAction.reviewLabel',
          'Review and install {{value0}}',
          { value0: entry.name }
        )}
        onClick={onOpen}
      >
        {translate('auto.components.settings.PluginCardAction.review', 'Review & install')}
      </Button>
    )
  }
  return (
    <Button
      variant="outline"
      size="xs"
      className="w-32"
      disabled={refreshing}
      aria-label={translate(
        'auto.components.settings.PluginManagerRows.installName',
        'Install {{value0}}',
        { value0: entry.name }
      )}
      onClick={onInstall}
    >
      {phase?.kind === 'error'
        ? translate('auto.components.settings.PluginCardAction.retry', 'Try again')
        : translate('auto.components.settings.PluginMarketplaceListingRow.install', 'Install')}
    </Button>
  )
}
