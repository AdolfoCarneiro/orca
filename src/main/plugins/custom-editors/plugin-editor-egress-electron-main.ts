// Electron entry for plugin-editor-egress.electron.test.ts; bundled with the real guest policy.
import { app, BrowserWindow, netLog, session } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  pluginEditorGuestToken,
  pluginEditorGuestUrl
} from '../../../shared/plugins/plugin-editor-guest'
import {
  hardenPluginEditorGuest,
  installPluginEditorSessionPolicy
} from './plugin-editor-guest-policy'

type ProbeConfig = {
  resultPath: string
  netLogPath: string
  documents: Record<string, string>
  /** Documents loaded in the guarded editor partition; `baseline` loads in a plain session. */
  guarded: string[]
  baseline: string[]
}

const TOKENS = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => letter.repeat(32))

if (process.platform === 'linux') {
  app.disableHardwareAcceleration()
}
app.on('window-all-closed', () => {})

const titles: Record<string, string> = {}

async function load(
  window: BrowserWindow,
  name: string,
  url: string,
  pressSave = false
): Promise<void> {
  await window.loadURL(url)
  if (pressSave) {
    // Real input as the OS would deliver it, after the page tried to forge the same chord.
    window.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'S',
      modifiers: ['meta', 'control']
    })
  }
  // Network attempts and ICE gathering run after load; the host clock decides when to stop.
  await new Promise((resolve) => setTimeout(resolve, 4000))
  titles[name] = window.webContents.getTitle()
  window.destroy()
}

async function run(): Promise<void> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written by plugin-editor-egress.electron.test.ts.
  const config = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as ProbeConfig
  await app.whenReady()
  await netLog.startLogging(config.netLogPath, { captureMode: 'includeSensitive' })
  const served = new Map<string, string>()
  const editorSession = session.fromPartition('orca-plugin-editor-probe')
  await installPluginEditorSessionPolicy(
    editorSession,
    (token) => served.get(token) ?? null,
    pluginEditorGuestToken
  )
  const chords: unknown[] = []
  let next = 0
  for (const name of config.guarded) {
    const token = TOKENS[next++]!
    served.set(token, config.documents[name]!)
    const window = new BrowserWindow({
      show: false,
      webPreferences: { session: editorSession, sandbox: true, contextIsolation: true }
    })
    hardenPluginEditorGuest(window.webContents, (chord) => chords.push(chord))
    await load(window, name, pluginEditorGuestUrl(token), name === 'keys')
  }
  for (const name of config.baseline) {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { partition: `probe-baseline-${name}`, sandbox: true, contextIsolation: true }
    })
    window.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    await load(
      window,
      name,
      `data:text/html;base64,${Buffer.from(config.documents[name]!).toString('base64')}`
    )
  }
  const resolvedProxy = await editorSession.resolveProxy('https://example.invalid/')
  await netLog.stopLogging()
  writeFileSync(config.resultPath, JSON.stringify({ resolvedProxy, chords, titles }))
}

const timeout = setTimeout(() => app.exit(2), 60_000)
run()
  .then(() => {
    clearTimeout(timeout)
    app.quit()
  })
  .catch((error: unknown) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written by plugin-editor-egress.electron.test.ts.
    const config = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as ProbeConfig
    writeFileSync(config.resultPath, JSON.stringify({ error: String(error) }))
    app.exit(1)
  })
