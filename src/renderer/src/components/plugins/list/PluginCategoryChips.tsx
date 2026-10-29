import { translate } from '@/i18n/i18n'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { pluginCategoryLabel } from './plugin-category-label'
import { PluginCategoryIcon } from './PluginCategoryBadge'
import type { PluginListEntry } from './plugin-list-entries'
import { pluginFilterCategories, type PluginListFilter } from './plugin-list-filter'

/** Category filters as always-visible chips; none selected means every category. */
export function PluginCategoryChips({
  entries,
  filter,
  onChange
}: {
  entries: readonly PluginListEntry[]
  filter: PluginListFilter
  onChange: (filter: PluginListFilter) => void
}): React.JSX.Element | null {
  const categories = pluginFilterCategories(entries).map(([category]) => category)
  if (categories.length === 0) {
    return null
  }
  return (
    <ToggleGroup
      type="multiple"
      variant="segmented"
      size="xs"
      spacing={1}
      value={[...filter.categories]}
      onValueChange={(next) => onChange({ ...filter, categories: new Set(next) })}
      aria-label={translate('auto.components.settings.PluginFilterPopover.kind', 'Category')}
      className="flex-wrap"
    >
      {categories.map((category) => (
        <ToggleGroupItem key={category} value={category}>
          <PluginCategoryIcon category={category} />
          {pluginCategoryLabel(category)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
