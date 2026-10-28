import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../../shared/plugins/manifest/plugin-schema-field-docs'
import { PLUGIN_PANEL_CSP } from '../../../shared/plugins/plugin-panel-shell'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import { PluginPanelController } from './plugin-panel-controller'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createEditorPlugin(): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-custom-editor-'))
  roots.push(rootDir)
  await mkdir(join(rootDir, 'editor'))
  await writeFile(join(rootDir, 'editor', 'index.html'), '<main id="canvas"></main>')
  return {
    pluginKey: 'stablyai.excalidraw',
    rootDir,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id: 'excalidraw',
      publisher: 'stablyai',
      name: 'Excalidraw',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      contributes: {
        customEditors: [
          {
            id: 'excalidraw',
            title: 'Excalidraw',
            fileTypes: ['excalidraw'],
            entry: 'editor/index.html'
          }
        ]
      }
    }),
    consentFingerprint: 'sha256-consented',
    contentHash: null,
    isDev: true
  }
}

function controllerFor(plugin: ValidDiscoveredPlugin | null, verify = vi.fn()) {
  return new PluginPanelController({
    resolveApprovedPlugin: (pluginKey) => (plugin?.pluginKey === pluginKey ? plugin : null),
    contentVerifier: { verify },
    executeHostCall: vi.fn(),
    log: () => vi.fn()
  })
}

describe('PluginPanelController custom editor entries', () => {
  it('wraps the editor in the panel CSP shell with the key forwarder, after verifying bytes', async () => {
    const plugin = await createEditorPlugin()
    const verify = vi.fn().mockResolvedValue(undefined)
    const entry = await controllerFor(plugin, verify).readCustomEditorEntry(
      plugin.pluginKey,
      'excalidraw'
    )
    expect(verify).toHaveBeenCalledWith(plugin)
    expect(entry?.html).toContain(PLUGIN_PANEL_CSP)
    // No network, no remote scripts: every fetch, socket and beacon is refused.
    expect(PLUGIN_PANEL_CSP).toContain("connect-src 'none'")
    expect(PLUGIN_PANEL_CSP).toContain("default-src 'none'")
    expect(entry?.html).toContain("type: 'orca-editor-keydown'")
    expect(entry?.html.endsWith('<main id="canvas"></main>')).toBe(true)
    // Why: the editor is told nothing about where the file lives or where the plugin is.
    expect(entry?.html).not.toContain(plugin.rootDir)
  })

  it('returns null for unknown editors, unapproved plugins and tampered bytes', async () => {
    const plugin = await createEditorPlugin()
    await expect(
      controllerFor(plugin).readCustomEditorEntry(plugin.pluginKey, 'other')
    ).resolves.toBeNull()
    await expect(
      controllerFor(null).readCustomEditorEntry(plugin.pluginKey, 'excalidraw')
    ).resolves.toBeNull()
    const tampered = vi.fn().mockRejectedValue(new Error('content changed'))
    await expect(
      controllerFor(plugin, tampered).readCustomEditorEntry(plugin.pluginKey, 'excalidraw')
    ).resolves.toBeNull()
  })

  it('gives custom editors no panel session, so they cannot call host actions', async () => {
    const plugin = await createEditorPlugin()
    const controller = controllerFor(plugin)
    const entry = await controller.readCustomEditorEntry(plugin.pluginKey, 'excalidraw')
    expect(entry).not.toHaveProperty('sessionToken')
    await expect(controller.open('owner', plugin.pluginKey, 'excalidraw')).resolves.toBeNull()
  })
})
