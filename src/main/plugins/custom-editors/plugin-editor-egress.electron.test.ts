import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, describe, expect, it } from 'vitest'
import { runBrowserRouteEgressElectron } from '../../browser/browser-route-egress-electron-launch'
import { findHostResolverEvents } from '../../browser/browser-route-dns-prefetch-fixture'
import { buildPluginPanelShellHtml } from '../../../shared/plugins/plugin-panel-shell'

const roots: string[] = []
const servers: (Server | HttpServer)[] = []

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))))
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function listen(server: Server | HttpServer): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('probe listener has no port')
  }
  return address.port
}

/** Records every HTTP request and WebSocket upgrade by path. */
async function httpRecorder(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = []
  const server = createHttpServer((request, response) => {
    hits.push(request.url ?? '/')
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.end('reached')
  })
  server.on('upgrade', (request, socket: Socket) => {
    hits.push(`upgrade:${request.url ?? '/'}`)
    socket.destroy()
  })
  return { port: await listen(server), hits }
}

/** A TURN-over-TCP stand-in: counts the connections a peer connection opens to it. */
async function turnRecorder(): Promise<{ port: number; connections: () => number }> {
  let connections = 0
  const server = createServer((socket: Socket) => {
    connections += 1
    socket.destroy()
  })
  return { port: await listen(server), connections: () => connections }
}

const escapeAttribute = (html: string): string =>
  html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/** Every way a page reaches out: fetch, WebSocket, an image and TURN over TCP. */
function attempts(http: number, turn: number, tag: string): string {
  const base = `http://127.0.0.1:${http}`
  return (
    `<img src="${base}/img-${tag}">` +
    '<script>' +
    // Proves the attempts ran: each frame signs the top document's title.
    `try { top.document.title += '${tag};' } catch (_) {}` +
    `fetch('${base}/fetch-${tag}').catch(function () {});` +
    `try { new WebSocket('ws://127.0.0.1:${http}/ws-${tag}') } catch (_) {}` +
    `try { var pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:127.0.0.1:${turn}?transport=tcp', username: 'u', credential: 'c' }] });` +
    "pc.createDataChannel('d'); pc.createOffer().then(function (o) { return pc.setLocalDescription(o) }) } catch (_) {}" +
    '</script>'
  )
}

/** The attempts from the document itself and from `srcdoc` and `javascript:` children. */
function attackDocument(http: number, turn: number, dnsHost: string, name: string): string {
  const child = (tag: string) => attempts(http, turn, `${name}-${tag}`)
  return (
    `<link rel="dns-prefetch" href="https://${dnsHost}">` +
    `<body>${child('top')}` +
    `<iframe srcdoc="${escapeAttribute(child('srcdoc'))}"></iframe>` +
    `<iframe src="${escapeAttribute(`javascript:${JSON.stringify(child('js'))}`)}"></iframe>` +
    '</body>'
  )
}

/** A page that forges the save chord and the old shell's keydown message. */
const FORGED_SAVE =
  '<body><script>' +
  "document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', metaKey: true, ctrlKey: true, bubbles: true }));" +
  "window.parent.postMessage({ type: 'orca-editor-keydown', key: 's', code: 'KeyS', metaKey: true }, '*')" +
  '</script></body>'

type Probe = {
  hits: string[]
  turnConnections: Record<string, number>
  resolvedProxy: string
  chords: { key: string }[]
  titles: Record<string, string>
  netLog: string
  dnsHosts: Record<string, string>
}

async function runProbe(): Promise<Probe> {
  const root = mkdtempSync(join(tmpdir(), 'orca-plugin-editor-egress-'))
  roots.push(root)
  const http = await httpRecorder()
  const turns = {
    shell: await turnRecorder(),
    raw: await turnRecorder(),
    baseline: await turnRecorder()
  }
  const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  const dnsHosts = {
    shell: `orca-editor-shell-${unique}.invalid`,
    raw: `orca-editor-raw-${unique}.invalid`,
    baseline: `orca-editor-baseline-${unique}.invalid`
  }
  const mainPath = join(root, 'main.cjs')
  await build({
    entryPoints: [join(__dirname, 'plugin-editor-egress-electron-main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: mainPath,
    logLevel: 'silent'
  })
  const doc = (name: keyof typeof turns) =>
    attackDocument(http.port, turns[name].port, dnsHosts[name], name)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      resultPath: join(root, 'result.json'),
      netLogPath: join(root, 'netlog.json'),
      documents: {
        // The exact shell editors get, and a page without CSP or prelude: the session alone holds.
        shell: buildPluginPanelShellHtml(doc('shell')),
        raw: `<!doctype html>${doc('raw')}`,
        baseline: `<!doctype html>${doc('baseline')}`,
        keys: FORGED_SAVE
      },
      guarded: ['shell', 'raw', 'keys'],
      baseline: ['baseline']
    })
  )
  const result = await runBrowserRouteEgressElectron(root, mainPath)
  return {
    hits: http.hits,
    turnConnections: Object.fromEntries(
      Object.entries(turns).map(([name, turn]) => [name, turn.connections()])
    ),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written by plugin-editor-egress-electron-main.ts.
    resolvedProxy: result.resolvedProxy as string,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written by plugin-editor-egress-electron-main.ts.
    chords: result.chords as { key: string }[],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written by plugin-editor-egress-electron-main.ts.
    titles: result.titles as Record<string, string>,
    netLog: readFileSync(join(root, 'netlog.json'), 'utf8'),
    dnsHosts
  }
}

describe('plugin custom editor guest egress under Electron', () => {
  it('blocks fetch, WebSocket, images and TURN/TCP from the editor and its child frames', async () => {
    const probe = await runProbe()
    const reached = (name: string) =>
      probe.hits.filter((hit) => hit.includes(`/${name}-`) || hit.includes(`-${name}-`))

    // The same page in a plain session reaches the listeners, so the probe can see a leak.
    expect(reached('baseline').length).toBeGreaterThan(0)
    expect(probe.turnConnections.baseline).toBeGreaterThan(0)

    expect(probe.resolvedProxy).toBe('SOCKS5 127.0.0.1:9')
    // Every frame of both guarded pages really ran its attempts.
    for (const name of ['shell', 'raw', 'baseline']) {
      for (const frame of ['top', 'srcdoc', 'js']) {
        expect(probe.titles[name]).toContain(`${name}-${frame};`)
      }
    }
    // In the editor partition nothing leaves, with the production shell or with none at all.
    expect(reached('shell')).toEqual([])
    expect(reached('raw')).toEqual([])
    expect(probe.turnConnections.shell).toBe(0)
    expect(probe.turnConnections.raw).toBe(0)

    // Only real input produces a save chord; the page's forged keydown and message do not.
    expect(probe.chords).toHaveLength(1)
    expect(probe.chords[0]).toMatchObject({ key: 's' })

    // Residual, as for doc previews: Electron 43 resolves `<link rel="dns-prefetch">` outside the
    // session's proxy and request hooks, so a hostname label still reaches the system resolver.
    // When an upstream fix lands, flip this to expect no resolver events.
    expect(findHostResolverEvents(probe.netLog, probe.dnsHosts.shell).length).toBeGreaterThan(0)
  }, 120_000)
})
