import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from './manifest/plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE } from './manifest/plugin-schema-field-docs'
import { pluginCatalogReleaseEntry } from './catalog/plugin-catalog-release'
import { pluginCatalogTypes } from './catalog/plugin-catalog-types'
import { pluginContributionSummary } from './plugin-contribution-summary'
import { matchCustomEditorFileType } from './plugin-custom-editor-contribution'
import { requiresPluginContentApproval } from './approval/plugin-consent-fingerprint'
import { pluginUpdateAccessGrowth } from './approval/plugin-update-access-growth'

const excalidraw = {
  id: 'excalidraw',
  title: 'Excalidraw',
  fileTypes: ['excalidraw', 'excalidraw.json'],
  entry: 'editor/index.html'
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 2,
    execution: 'sandboxed-ui',
    id: 'excalidraw',
    publisher: 'stablyai',
    name: 'Excalidraw',
    version: '1.0.0',
    engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
    contributes: { customEditors: [excalidraw] },
    ...overrides
  }
}

function parsed(overrides: Record<string, unknown> = {}) {
  const result = parsePluginManifest(manifest(overrides))
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.manifest
}

describe('contributes.customEditors', () => {
  it('accepts a sandboxed-ui editor and defaults every other point', () => {
    expect(parsed().contributes.customEditors).toEqual([excalidraw])
  })

  it('accepts a read-only bytes editor', () => {
    const spreadsheet = {
      id: 'spreadsheet',
      title: 'Spreadsheet',
      fileTypes: ['xlsx'],
      entry: 'editor/index.html',
      contentKind: 'bytes',
      readonly: true
    }
    expect(
      parsed({ contributes: { customEditors: [spreadsheet] } }).contributes.customEditors
    ).toEqual([spreadsheet])
  })

  it('refuses a bytes editor that does not declare readonly', () => {
    const result = parsePluginManifest(
      manifest({
        contributes: { customEditors: [{ ...excalidraw, contentKind: 'bytes' }] }
      })
    )
    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.error).toContain('readonly')
  })

  it('refuses an unknown content kind', () => {
    expect(
      parsePluginManifest(
        manifest({ contributes: { customEditors: [{ ...excalidraw, contentKind: 'binary' }] } })
      )
    ).toMatchObject({ ok: false })
  })

  it('needs at least the sandboxed-ui profile', () => {
    const result = parsePluginManifest(manifest({ execution: 'declarative' }))
    expect(result.ok).toBe(false)
  })

  it('needs the manifest v2 engine floor', () => {
    expect(parsePluginManifest(manifest({ engines: { orca: '>=1.4.200' } }))).toMatchObject({
      ok: false
    })
  })

  it.each([
    [{ ...excalidraw, fileTypes: [] }],
    [{ ...excalidraw, fileTypes: ['.excalidraw'] }],
    [{ ...excalidraw, fileTypes: ['Excalidraw'] }],
    [{ ...excalidraw, fileTypes: ['excalidraw', 'excalidraw'] }],
    [{ ...excalidraw, priority: 'always' }],
    [{ ...excalidraw, entry: '../escape.html' }],
    [{ ...excalidraw, path: 'extra' }]
  ])('refuses a malformed editor %#', (editor) => {
    expect(
      parsePluginManifest(manifest({ contributes: { customEditors: [editor] } }))
    ).toMatchObject({ ok: false })
  })

  it('refuses duplicate editor ids', () => {
    const result = parsePluginManifest(
      manifest({ contributes: { customEditors: [excalidraw, { ...excalidraw, title: 'Again' }] } })
    )
    expect(result).toEqual({
      ok: false,
      error: 'contributes.customEditors[1]: duplicate customEditors id: excalidraw'
    })
  })

  it('lists as a panel type with dotted file types, and suggests for single-extension types', () => {
    const plugin = parsed()
    expect(pluginCatalogTypes(plugin)).toEqual(['panel'])
    expect(pluginContributionSummary(plugin)).toEqual([
      { kind: 'customEditors', name: 'Excalidraw', detail: '.excalidraw, .excalidraw.json' }
    ])
    expect(
      pluginCatalogReleaseEntry(plugin, { commit: 'a'.repeat(40), contentHash: 'h' })
    ).toMatchObject({ fileTypes: ['excalidraw'], editorFileTypes: ['excalidraw'] })
  })

  it('binds approval to the editor bytes and counts a new file type as more reach', () => {
    const plugin = parsed()
    expect(requiresPluginContentApproval(plugin)).toBe(true)
    const wider = parsed({
      contributes: { customEditors: [{ ...excalidraw, fileTypes: ['excalidraw', 'svg'] }] }
    })
    expect(pluginUpdateAccessGrowth(plugin, wider).contributions).toEqual(['customEditors'])
    expect(pluginUpdateAccessGrowth(plugin, plugin).contributions).toEqual([])
  })

  it('counts an editor that starts editing, takes over opening, or changes content kind', () => {
    const editor = (fields: Record<string, unknown>) =>
      parsed({ contributes: { customEditors: [{ ...excalidraw, ...fields }] } })
    const viewer = editor({ readonly: true, priority: 'option' })
    const growth = (next: ReturnType<typeof parsed>) =>
      pluginUpdateAccessGrowth(viewer, next).contributions
    expect(growth(editor({ priority: 'option' }))).toEqual(['customEditors'])
    expect(growth(editor({ readonly: true }))).toEqual(['customEditors'])
    expect(growth(editor({ readonly: true, priority: 'option', contentKind: 'bytes' }))).toEqual([
      'customEditors'
    ])
    // Narrower reach keeps the approval.
    expect(pluginUpdateAccessGrowth(editor({}), viewer).contributions).toEqual([])
    expect(
      growth(editor({ readonly: true, priority: 'option', fileTypes: ['excalidraw'] }))
    ).toEqual([])
  })
})

describe('matchCustomEditorFileType', () => {
  it('matches the longest suffix, case-insensitively, across path styles', () => {
    const types = ['excalidraw', 'excalidraw.json', 'json']
    expect(matchCustomEditorFileType('/repo/a/Diagram.EXCALIDRAW', types)).toBe('excalidraw')
    expect(matchCustomEditorFileType('C:\\repo\\d.excalidraw.json', types)).toBe('excalidraw.json')
    expect(matchCustomEditorFileType('/repo/package.json', ['excalidraw.json'])).toBeNull()
  })

  it('never matches a bare suffix name or a directory segment', () => {
    expect(matchCustomEditorFileType('/repo/.excalidraw', ['excalidraw'])).toBeNull()
    expect(matchCustomEditorFileType('/repo/x.excalidraw/readme.md', ['excalidraw'])).toBeNull()
  })
})
