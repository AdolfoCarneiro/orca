import { Code, Command, FolderTree, Languages, Palette, Server, Tag } from 'lucide-react'
import { Badge } from '../../ui/badge'
import { pluginCategoryLabel } from './plugin-category-label'
import type { PluginListEntry } from './plugin-list-entries'
import { isPluginFilterKind, pluginFilterKinds, type PluginFilterKind } from './plugin-list-filter'

const KIND_ICON: Record<PluginFilterKind, typeof Palette> = {
  themes: Palette,
  icons: FolderTree,
  languages: Languages,
  commands: Command,
  machines: Server
}

/** What kind of plugin this is, as a chip with its icon; nothing when the kind is unknown. */
export function PluginCategoryBadge({
  entry
}: {
  entry: PluginListEntry
}): React.JSX.Element | null {
  const [kind] = pluginFilterKinds(entry)
  if (!kind) {
    return null
  }
  // Why: syntax packs share the Languages category with interface languages but are for code.
  const forCode =
    kind === 'languages' &&
    entry.types.includes('syntax') &&
    !entry.types.includes('interface-language')
  const Icon = forCode ? Code : isPluginFilterKind(kind) ? KIND_ICON[kind] : Tag
  return (
    <Badge variant="hostContext">
      <Icon aria-hidden="true" />
      {pluginCategoryLabel(kind)}
    </Badge>
  )
}
