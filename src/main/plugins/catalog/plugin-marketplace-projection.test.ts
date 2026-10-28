import { describe, expect, it } from 'vitest'
import { pluginCatalogReleaseSchema } from '../../../shared/plugins/catalog/plugin-catalog-release'
import { pluginMarketplaceListingSchema } from '../../../shared/plugins/catalog/plugin-marketplace'
import {
  pluginCatalogListingDetails,
  pluginMarketplaceListing
} from './plugin-marketplace-projection'

describe('pluginCatalogListingDetails', () => {
  it('flattens the display fields a release carries', () => {
    const release = pluginCatalogReleaseSchema.parse({
      version: '1.2.0',
      commit: 'c'.repeat(40),
      contentHash: 'f'.repeat(64),
      execution: 'data',
      minimumOrca: '1.4.0',
      types: ['app-theme'],
      name: 'Orca Midnight',
      license: 'MIT',
      updatedAt: '2026-10-20',
      changelog: 'Warmer comments.'
    })
    expect(pluginCatalogListingDetails(release)).toEqual({
      name: 'Orca Midnight',
      version: '1.2.0',
      license: 'MIT',
      updatedAt: '2026-10-20',
      changelog: 'Warmer comments.'
    })
    expect(pluginCatalogListingDetails(undefined)).toEqual({})
  })
})

describe('pluginMarketplaceListing trust', () => {
  const listing = (catalogUrl: string, pluginKey: string) => {
    const source = { kind: 'git' as const, url: catalogUrl, ref: 'main' }
    const marketplace = pluginMarketplaceListingSchema.parse({
      name: 'Orca Plugins',
      owner: 'stablyai',
      plugins: [
        {
          id: pluginKey,
          source: { kind: 'git', url: 'https://github.com/stablyai/orca-plugins.git', ref: 'v1' }
        }
      ]
    })
    return pluginMarketplaceListing({
      source: { id: 'a'.repeat(32), source, addedAt: 0 },
      snapshot: {
        schemaVersion: 2,
        sourceId: 'a'.repeat(32),
        source,
        marketplaceCommit: 'b'.repeat(40),
        fetchedAt: 0,
        marketplace
      },
      entry: marketplace.plugins[0]!,
      hostVersion: null,
      blocked: null
    })
  }

  it('marks official what the official catalog lists, whatever the id', () => {
    const official = 'https://github.com/stablyai/orca-plugins.git'
    expect(listing(official, 'stablyai.spreadsheet').official).toBe(true)
    expect(listing(official, 'stablyai.orca-gleam').official).toBe(true)
    expect(
      listing('https://github.com/acme/orca-plugins.git', 'stablyai.orca-gleam').official
    ).toBe(false)
  })
})
