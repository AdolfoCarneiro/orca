/**
 * Invariant: a plugin custom editor opens matching files in the editor tab, edits flow into
 * Orca's buffer without dirtying it on open, the save shortcut pressed inside the frame saves
 * through Orca, Source shows the same buffer, the frame has no network, and turning plugins
 * off falls back to Source.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { expect, test } from './helpers/orca-app'
import { disablePluginSystem, enableDevPlugins, openRepoFile } from './helpers/plugin-smoke'

const FILE = 'custom-editor-smoke.sketch'
const FRAME = 'iframe[title="Sketch Pad"]'

// A tiny protocol-complete editor: a textarea that posts debounced full-text edits.
const EDITOR_HTML = `<textarea id="doc" style="width:100%;height:90vh"></textarea>
<output id="probe"></output>
<script>
const doc = document.getElementById('doc')
let timer = null
const post = (message) => window.parent.postMessage(message, '*')
const flush = () => { clearTimeout(timer); timer = null; post({ type: 'orca-editor-edit', text: doc.value }) }
doc.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(flush, 400) })
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  const data = event.data
  if (data.type === 'orca-editor-document') { doc.value = data.text; doc.readOnly = data.readOnly }
  if (data.type === 'orca-editor-flush') {
    if (timer) flush()
    post({ type: 'orca-editor-flushed', requestId: data.requestId })
  }
})
window.probeNetwork = (url) => fetch(url).then(() => 'reached', () => 'blocked')
post({ type: 'orca-editor-ready' })
</script>`

async function writeEditorPlugin(root: string): Promise<void> {
  await mkdir(join(root, 'editor'), { recursive: true })
  await writeFile(join(root, 'editor', 'index.html'), EDITOR_HTML)
  await writeFile(
    join(root, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id: 'sketch-pad',
      publisher: 'samples',
      name: 'Sketch Pad',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      contributes: {
        customEditors: [
          {
            id: 'sketch',
            title: 'Sketch Pad',
            fileTypes: ['sketch'],
            entry: 'editor/index.html'
          }
        ]
      }
    })
  )
}

function activeFileDirty(page: Page): Promise<boolean | undefined> {
  return page.evaluate((name) => {
    const state = window.__store?.getState()
    return state?.openFiles.find((file) => file.relativePath === name)?.isDirty
  }, FILE)
}

async function chooseView(page: Page, label: string): Promise<void> {
  await page.getByRole('radio', { name: label, exact: true }).click()
}

test('plugin custom editor edits and saves through Orca', async ({ orcaPage, seededRepoPath }) => {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-custom-editor-'))
  const filePath = join(seededRepoPath, FILE)
  const requests: string[] = []
  const probe = createServer((request, response) => {
    requests.push(request.url ?? '/')
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.end('reached')
  })
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const probeUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/leak`
  try {
    await writeEditorPlugin(pluginRoot)
    await writeFile(filePath, 'first line\n')
    await enableDevPlugins(orcaPage, [pluginRoot])
    await openRepoFile(orcaPage, seededRepoPath, FILE)

    const frame = orcaPage.frameLocator(FRAME)
    const textarea = frame.locator('#doc')
    await expect(textarea).toHaveValue('first line\n', { timeout: 15_000 })
    // Opening a file in its custom editor must not dirty it.
    expect(await activeFileDirty(orcaPage)).toBe(false)

    await textarea.click()
    await textarea.press('End')
    await textarea.pressSequentially('second line')
    await expect.poll(() => activeFileDirty(orcaPage)).toBe(true)

    // Saved inside the debounce window: Orca must flush the frame first.
    await textarea.pressSequentially('!')
    await textarea.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect.poll(() => readFile(filePath, 'utf8')).toBe('first line\nsecond line!')
    await expect.poll(() => activeFileDirty(orcaPage)).toBe(false)

    // No network from the frame: CSP refuses the request before it leaves.
    const network = await frame.locator('#probe').evaluate(
      (_node, url) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture editor defines probeNetwork.
        (window as unknown as { probeNetwork: (target: string) => Promise<string> }).probeNetwork(
          url
        ),
      probeUrl
    )
    expect(network).toBe('blocked')
    expect(requests).toEqual([])

    await chooseView(orcaPage, 'Source')
    await expect(orcaPage.locator(FRAME)).toHaveCount(0)
    await expect(orcaPage.locator('.monaco-editor .view-lines')).toContainText('second line!')
    await chooseView(orcaPage, 'Sketch Pad')
    await expect(textarea).toHaveValue('first line\nsecond line!')

    await disablePluginSystem(orcaPage)
    await expect(orcaPage.locator(FRAME)).toHaveCount(0, { timeout: 15_000 })
    await expect(orcaPage.locator('.monaco-editor .view-lines')).toBeVisible()
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await new Promise((resolve) => probe.close(resolve))
    await rm(filePath, { force: true })
    await rm(pluginRoot, { recursive: true, force: true })
  }
})

const BYTES_FILE = 'custom-editor-smoke.hexbook'
const BYTES_FRAME = 'iframe[title="Hex Book"]'

// Reports what a bytes editor receives, and tries an edit Orca must ignore.
const BYTES_EDITOR_HTML = `<output id="summary">waiting</output>
<script>
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  const data = event.data
  if (data.type !== 'orca-editor-document' || !data.content || data.content.kind !== 'bytes') return
  const bytes = new Uint8Array(data.content.bytes)
  document.getElementById('summary').textContent =
    'v' + data.version + ' ' + data.fileType + ' ' + data.readOnly + ' ' + bytes.length + ':' +
    Array.from(bytes.slice(0, 4), (byte) => byte.toString(16)).join(' ') +
    ' name=' + (window.name.includes('hexbook') ? 'leaks' : 'opaque')
  window.parent.postMessage({ type: 'orca-editor-edit', text: 'tampered' }, '*')
})
window.parent.postMessage({ type: 'orca-editor-ready' }, '*')
</script>`

test('a bytes custom editor views a binary file read-only', async ({
  orcaPage,
  seededRepoPath
}) => {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-bytes-editor-'))
  const filePath = join(seededRepoPath, BYTES_FILE)
  // NULs make Orca treat it as binary, like a zip-based workbook.
  const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0x10])
  try {
    await mkdir(join(pluginRoot, 'editor'), { recursive: true })
    await writeFile(join(pluginRoot, 'editor', 'index.html'), BYTES_EDITOR_HTML)
    await writeFile(
      join(pluginRoot, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 2,
        execution: 'sandboxed-ui',
        id: 'hex-book',
        publisher: 'samples',
        name: 'Hex Book',
        version: '1.0.0',
        engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
        contributes: {
          customEditors: [
            {
              id: 'hex',
              title: 'Hex Book',
              fileTypes: ['hexbook'],
              entry: 'editor/index.html',
              contentKind: 'bytes',
              readonly: true
            }
          ]
        }
      })
    )
    await writeFile(filePath, original)
    await enableDevPlugins(orcaPage, [pluginRoot])
    await openRepoFile(orcaPage, seededRepoPath, BYTES_FILE)

    const summary = orcaPage.frameLocator(BYTES_FRAME).locator('#summary')
    await expect(summary).toHaveText('v1 hexbook true 8:50 4b 3 4 name=opaque', {
      timeout: 15_000
    })
    // The editor's edit is ignored: the file and the tab stay untouched.
    expect(await readFile(filePath)).toEqual(original)
    expect(
      await orcaPage.evaluate(
        (name) =>
          window.__store?.getState().openFiles.find((file) => file.relativePath === name)?.isDirty,
        BYTES_FILE
      )
    ).toBe(false)

    // Source of a binary file is the binary placeholder, never decoded bytes.
    await chooseView(orcaPage, 'Source')
    await expect(orcaPage.locator(BYTES_FRAME)).toHaveCount(0)
    await expect(orcaPage.getByText('Binary file — cannot display')).toBeVisible()
    await chooseView(orcaPage, 'Hex Book')
    await expect(summary).toContainText('hexbook true 8:')

    await disablePluginSystem(orcaPage)
    await expect(orcaPage.locator(BYTES_FRAME)).toHaveCount(0, { timeout: 15_000 })
    await expect(orcaPage.getByText('Binary file — cannot display')).toBeVisible()
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(filePath, { force: true })
    await rm(pluginRoot, { recursive: true, force: true })
  }
})
