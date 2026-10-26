import { describe, expect, it } from 'vitest'
import type { PluginListEntry } from './plugin-list-entries'
import { pluginArtTypes } from './PluginRowArt'

function entry(categories: string[], types: PluginListEntry['types'] = []): PluginListEntry {
  return {
    pluginKey: 'stablyai.orca-midnight-theme',
    name: 'Orca Midnight Theme',
    publisher: 'stablyai',
    version: null,
    description: null,
    official: true,
    categories,
    types,
    minimumOrca: null,
    updateVersion: null,
    catalogIds: [],
    updatable: false,
    autoUpdate: { updatedTo: null, needsReview: false },
    installed: null,
    listing: null
  }
}

describe('pluginArtTypes', () => {
  it('reads a format 1 listing from its categories, so its art shows what it is', () => {
    expect(pluginArtTypes(entry(['themes', 'official']))).toEqual(['app-theme'])
    expect(pluginArtTypes(entry(['icons']))).toEqual(['icon-theme'])
    expect(pluginArtTypes(entry(['vm-recipes']))).toEqual(['instructions'])
    expect(pluginArtTypes(entry(['skills']))).toEqual([])
  })

  it('prefers the catalog types over categories', () => {
    expect(pluginArtTypes(entry(['themes'], ['terminal-theme']))).toEqual(['terminal-theme'])
  })
})
