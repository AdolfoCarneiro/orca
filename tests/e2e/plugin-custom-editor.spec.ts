/**
 * Invariant: a plugin custom editor opens matching files in the editor tab as an isolated
 * `<webview>` guest, edits flow into Orca's buffer without dirtying it on open, only a real save
 * key press (never one the editor fakes) saves through Orca after flushing the editor, Source
 * shows the same buffer, the guest has no network, and turning plugins off falls back to Source.
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
const FRAME = 'webview[title="Sketch Pad"]'

// A tiny protocol-complete editor: a textarea that posts debounced full-text edits.
const EDITOR_HTML = `<textarea id="doc" style="width:100%;height:90vh"></textarea>
<output id="probe"></output>
<script>
const doc = document.getElementById('doc')
let timer = null
let version = 0
const post = (message) => window.parent.postMessage(message, '*')
const flush = () => {
  clearTimeout(timer); timer = null
  post({ type: 'orca-editor-edit', baseVersion: version, content: { kind: 'text', text: doc.value } })
}
doc.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(flush, 400) })
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  const data = event.data
  if (data.type === 'orca-editor-document') {
    version = data.version; doc.value = data.content.text; doc.readOnly = data.readOnly
  }
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

/** Runs a script in the editor guest; Playwright cannot enter a `<webview>` like a frame. */
function inGuest<T>(page: Page, title: string, script: string): Promise<T> {
  return page.evaluate(
    ([guestTitle, source]) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector matches only Orca's editor <webview>.
      const guest = document.querySelector(
        `webview[title="${guestTitle}"]`
      ) as Electron.WebviewTag | null
      return guest ? guest.executeJavaScript(source) : Promise.resolve(null)
    },
    [title, script] as const
  )
}

/** A real key press delivered to the guest, the way main sees user input. */
function pressSaveInGuest(page: Page, title: string): Promise<void> {
  return page.evaluate(
    ([guestTitle, modifier]) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector matches only Orca's editor <webview>.
      const guest = document.querySelector(`webview[title="${guestTitle}"]`) as Electron.WebviewTag
      guest.sendInputEvent({ type: 'keyDown', keyCode: 's', modifiers: [modifier] })
      guest.sendInputEvent({ type: 'keyUp', keyCode: 's', modifiers: [modifier] })
    },
    [title, process.platform === 'darwin' ? 'meta' : 'control'] as const
  )
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

    const value = () => inGuest<string | null>(orcaPage, 'Sketch Pad', 'doc.value')
    const type = (text: string) =>
      inGuest(
        orcaPage,
        'Sketch Pad',
        `doc.value += ${JSON.stringify(text)}; doc.dispatchEvent(new Event('input'))`
      )
    await expect.poll(value, { timeout: 15_000 }).toBe('first line\n')
    // Opening a file in its custom editor must not dirty it.
    expect(await activeFileDirty(orcaPage)).toBe(false)

    await type('second line')
    await expect.poll(() => activeFileDirty(orcaPage)).toBe(true)

    // The editor cannot save by faking the shortcut or the old key message.
    await inGuest(
      orcaPage,
      'Sketch Pad',
      "window.parent.postMessage({ type: 'orca-editor-keydown', key: 's', code: 'KeyS', metaKey: true, ctrlKey: true }, '*');" +
        "document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', metaKey: true, ctrlKey: true, bubbles: true }))"
    )
    await orcaPage.waitForTimeout(1_500)
    expect(await readFile(filePath, 'utf8')).toBe('first line\n')
    expect(await activeFileDirty(orcaPage)).toBe(true)

    // Saved inside the debounce window: Orca must flush the editor first.
    await type('!')
    await pressSaveInGuest(orcaPage, 'Sketch Pad')
    await expect.poll(() => readFile(filePath, 'utf8')).toBe('first line\nsecond line!')
    await expect.poll(() => activeFileDirty(orcaPage)).toBe(false)

    // No network from the guest: its session refuses the request before it leaves.
    const network = await inGuest<string>(
      orcaPage,
      'Sketch Pad',
      `probeNetwork(${JSON.stringify(probeUrl)})`
    )
    expect(network).toBe('blocked')
    expect(requests).toEqual([])

    await chooseView(orcaPage, 'Source')
    await expect(orcaPage.locator(FRAME)).toHaveCount(0)
    await expect(orcaPage.locator('.monaco-editor .view-lines')).toContainText('second line!')
    await chooseView(orcaPage, 'Sketch Pad')
    await expect.poll(value, { timeout: 15_000 }).toBe('first line\nsecond line!')

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
const BYTES_FRAME = 'webview[title="Hex Book"]'

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
  window.parent.postMessage({
    type: 'orca-editor-edit', baseVersion: data.version, content: { kind: 'text', text: 'tampered' }
  }, '*')
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

    const summary = () =>
      inGuest<string | null>(orcaPage, 'Hex Book', "document.getElementById('summary').textContent")
    await expect.poll(summary, { timeout: 15_000 }).toBe('v1 hexbook true 8:50 4b 3 4 name=opaque')
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
    await expect.poll(summary, { timeout: 15_000 }).toContain('hexbook true 8:')

    await disablePluginSystem(orcaPage)
    await expect(orcaPage.locator(BYTES_FRAME)).toHaveCount(0, { timeout: 15_000 })
    await expect(orcaPage.getByText('Binary file — cannot display')).toBeVisible()
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(filePath, { force: true })
    await rm(pluginRoot, { recursive: true, force: true })
  }
})
