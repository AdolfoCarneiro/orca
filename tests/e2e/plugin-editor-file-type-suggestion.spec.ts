/**
 * Official ids start with `orca-`, as the catalog requires for unsolicited suggestions.
 *
 * Invariant: a catalog plugin whose custom editor opens a file type is suggested both when the
 * file opens as Orca's binary placeholder (.xlsx) and when Orca already shows it as text
 * (.excalidraw as JSON); View plugin opens the plugin's page and never installs.
 */

import { PLUGIN_MANIFEST_V2_SINCE } from '../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { hashPluginTree } from '../../src/main/plugins/plugin-content-hash'
import { pluginContributionSummary } from '../../src/shared/plugins/plugin-contribution-summary'
import { parsePluginManifest } from '../../src/shared/plugins/manifest/plugin-manifest'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { commitRepository, configureFixtureGit, headCommit } from './helpers/plugin-git-fixture'
import { openRepoFile } from './helpers/plugin-smoke'

const EDITORS = [
  {
    repo: 'orca-spreadsheet',
    name: 'Spreadsheet Viewer',
    editor: {
      id: 'spreadsheet',
      title: 'Spreadsheet',
      fileTypes: ['xlsx'],
      entry: 'editor/index.html',
      contentKind: 'bytes'
    }
  },
  {
    repo: 'orca-excalidraw',
    name: 'Excalidraw',
    editor: {
      id: 'excalidraw',
      title: 'Excalidraw',
      fileTypes: ['excalidraw', 'excalidraw.json'],
      entry: 'editor/index.html'
    }
  }
] as const

async function createCatalogFixture(root: string) {
  const repositories = join(root, 'repositories')
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const gitEnvironment = await configureFixtureGit(home, repositories, [
    'orca-plugins',
    ...EDITORS.map((plugin) => plugin.repo)
  ])

  const plugins: unknown[] = []
  for (const plugin of EDITORS) {
    const dir = join(repositories, `${plugin.repo}.git`)
    await mkdir(join(dir, 'editor'), { recursive: true })
    await writeFile(join(dir, 'editor', 'index.html'), '<main>editor</main>\n')
    const manifest = {
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id: plugin.repo,
      publisher: 'stablyai',
      name: plugin.name,
      version: '1.0.0',
      license: 'MIT',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      contributes: { customEditors: [plugin.editor] }
    }
    await writeFile(join(dir, 'orca-plugin.json'), JSON.stringify(manifest))
    const parsed = parsePluginManifest(manifest)
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }
    const hashed = await hashPluginTree(dir)
    if (!hashed.ok) {
      throw new Error(hashed.error)
    }
    await commitRepository(dir, gitEnvironment)
    plugins.push({
      id: `stablyai.${plugin.repo}`,
      source: { kind: 'git', url: `https://github.com/stablyai/${plugin.repo}.git`, ref: 'v1.0.0' },
      releases: [
        {
          version: '1.0.0',
          commit: await headCommit(dir, gitEnvironment),
          contentHash: hashed.hash,
          execution: 'sandboxed-ui',
          minimumOrca: PLUGIN_MANIFEST_V2_SINCE,
          name: plugin.name,
          contributes: pluginContributionSummary(parsed.manifest),
          fileTypes: plugin.editor.fileTypes.filter((fileType) => !fileType.includes('.')),
          editorFileTypes: plugin.editor.fileTypes.filter((fileType) => !fileType.includes('.'))
        }
      ]
    })
  }

  const catalog = join(repositories, 'orca-plugins.git')
  await mkdir(catalog, { recursive: true })
  await writeFile(
    join(catalog, 'orca-catalog.json'),
    JSON.stringify({ catalogVersion: 2, name: 'Orca Plugins', owner: 'stablyai', plugins })
  )
  await commitRepository(catalog, gitEnvironment)

  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  // NULs make Orca show its binary placeholder, as it does for a real workbook.
  await writeFile(join(workspace, 'book.xlsx'), Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]))
  await writeFile(join(workspace, 'scene.excalidraw'), '{"type":"excalidraw","elements":[]}\n')
  await commitRepository(workspace, gitEnvironment)
  return { gitEnvironment, workspace: await realpath(workspace) }
}

async function proof(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name)
  await page.screenshot({ path })
  const dir = process.env.ORCA_PROOF_DIR
  if (dir) {
    await mkdir(dir, { recursive: true })
    await copyFile(path, join(dir, name))
  }
}

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('suggests a catalog custom editor for binary and already-highlighted files', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'orca-editor-suggestion-e2e-'))
  const fixture = await createCatalogFixture(root)
  const session = createRestartSession(testInfo as TestInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const page = launched.page
    await page.evaluate(async () => {
      const settings = await window.api.settings.set({ pluginSystemEnabled: true })
      window.__store?.setState({ settings })
      await window.api.plugins.refreshMarketplaces?.({})
    })
    await expect
      .poll(
        () =>
          page.evaluate(async () =>
            (await window.api.plugins.listMarketplacePlugins()).map((entry) => entry.pluginKey)
          ),
        { timeout: 60_000 }
      )
      .toEqual(expect.arrayContaining(['stablyai.orca-spreadsheet', 'stablyai.orca-excalidraw']))

    await attachRepoAndOpenTerminal(page, fixture.workspace)
    await openRepoFile(page, fixture.workspace, 'book.xlsx')
    await expect(page.getByText('A plugin can open .xlsx files: Spreadsheet Viewer')).toBeVisible({
      timeout: 15_000
    })
    await expect(page.getByText('Binary file — cannot display')).toBeVisible()
    await proof(page, testInfo, 'suggestion-xlsx.png')

    await openRepoFile(page, fixture.workspace, 'scene.excalidraw')
    const editorBanner = page.getByText('A plugin adds an editor for .excalidraw files: Excalidraw')
    await expect(editorBanner).toBeVisible({ timeout: 15_000 })
    // The file still opens as highlighted JSON underneath.
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('excalidraw')
    await proof(page, testInfo, 'suggestion-excalidraw.png')

    await page.getByRole('button', { name: 'View plugin' }).click()
    const pluginPage = page.getByRole('article')
    await expect(pluginPage.locator('#plugin-detail-heading')).toContainText('Excalidraw', {
      timeout: 30_000
    })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(
      await page.evaluate(async () =>
        (await window.api.plugins.list()).map((entry) => entry.pluginKey)
      )
    ).not.toContain('stablyai.orca-excalidraw')

    await page.evaluate(() => window.__store?.getState().closeSettingsPage())
    await page.getByRole('button', { name: 'Not now' }).click()
    await expect(editorBanner).toBeHidden()
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
