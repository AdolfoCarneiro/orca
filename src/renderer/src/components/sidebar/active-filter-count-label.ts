import { translate } from '@/i18n/i18n'

export function formatActiveFilterCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.sidebar.activeFilterCount_one', '{{count}} filter', { count })
    : translate('auto.components.sidebar.activeFilterCount_other', '{{count}} filters', { count })
}
