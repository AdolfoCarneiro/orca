import {
  Code,
  FilePen,
  Shapes,
  Command,
  FolderTree,
  Languages,
  Palette,
  Server,
  Tag,
  type LucideIcon
} from 'lucide-react'
import type { PluginListEntry } from './plugin-list-entries'
import { isPluginFilterKind, type PluginFilterKind } from './plugin-list-filter'

/** The one category→icon table: filter chips, card badges and the plugin page all read it. */
export const PLUGIN_CATEGORY_ICONS: Readonly<Record<PluginFilterKind, LucideIcon>> = {
  themes: Palette,
  icons: FolderTree,
  languages: Languages,
  commands: Command,
  machines: Server
}

/** Catalog categories that stand alone rather than folding into a kind. */
export const PLUGIN_NAMED_CATEGORY_ICONS: Readonly<Record<string, LucideIcon>> = {
  editors: FilePen,
  games: Shapes
}

/** Languages plugins that only add syntax highlighting are for code, not interface languages. */
export const PLUGIN_SYNTAX_CATEGORY_ICON: LucideIcon = Code

/** A catalog category Orca doesn't fold into a known kind. */
export const PLUGIN_UNKNOWN_CATEGORY_ICON: LucideIcon = Tag

export function pluginCategoryIcon(category: string): LucideIcon {
  if (isPluginFilterKind(category)) {
    return PLUGIN_CATEGORY_ICONS[category]
  }
  return Object.hasOwn(PLUGIN_NAMED_CATEGORY_ICONS, category)
    ? PLUGIN_NAMED_CATEGORY_ICONS[category]
    : PLUGIN_UNKNOWN_CATEGORY_ICON
}

/** One plugin's icon for a kind it belongs to; syntax-only language packs get the code icon. */
export function pluginEntryCategoryIcon(
  entry: Pick<PluginListEntry, 'types'>,
  kind: string
): LucideIcon {
  const syntaxOnly =
    kind === 'languages' &&
    entry.types.includes('syntax') &&
    !entry.types.includes('interface-language')
  return syntaxOnly ? PLUGIN_SYNTAX_CATEGORY_ICON : pluginCategoryIcon(kind)
}
