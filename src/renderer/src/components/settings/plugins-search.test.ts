import { describe, expect, it } from 'vitest'
import { getPluginsSectionPresentation } from './plugins-search'
import { getSettingsSectionSearchEntries, matchesSettingsSearch } from './settings-search'

describe('Plugins settings search', () => {
  it.each(['plugin', 'plugins', 'mod', 'mods', 'extension', 'extensions', 'Extensions'])(
    'finds the Plugins page for "%s"',
    (query) => {
      const entries = getSettingsSectionSearchEntries(getPluginsSectionPresentation())
      expect(matchesSettingsSearch(query, entries)).toBe(true)
    }
  )
})
