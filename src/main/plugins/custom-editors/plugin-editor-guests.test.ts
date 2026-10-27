import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fakeSession = vi.hoisted(() => ({
  setProxy: vi.fn(async () => {}),
  closeAllConnections: vi.fn(async () => {}),
  webRequest: { onBeforeRequest: vi.fn() },
  setPermissionRequestHandler: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
  setDevicePermissionHandler: vi.fn(),
  setSpellCheckerEnabled: vi.fn(),
  on: vi.fn(),
  protocol: { handle: vi.fn() }
}))

vi.mock('electron', () => ({ session: { fromPartition: () => fakeSession } }))

import {
  PLUGIN_EDITOR_GUEST_DELIVER_CHANNEL,
  PLUGIN_EDITOR_GUEST_EVENT_CHANNEL,
  PLUGIN_EDITOR_GUEST_POST_CHANNEL,
  PLUGIN_EDITOR_PARTITION
} from '../../../shared/plugins/plugin-editor-guest'
import {
  PLUGIN_EDITOR_GUEST_DELIVER,
  PLUGIN_EDITOR_GUEST_POST,
  PLUGIN_EDITOR_HOST_MESSAGE_TYPES
} from '../../../preload/plugin-editor-guest-channels'
import {
  CUSTOM_EDITOR_DOCUMENT_TYPE,
  CUSTOM_EDITOR_EDIT_REJECTED_TYPE,
  CUSTOM_EDITOR_FLUSH_TYPE
} from '../../../shared/plugins/plugin-custom-editor-bridge'
import { PANEL_PING_TYPE, PANEL_THEME_TYPE } from '../../../shared/plugins/plugin-panel-bridge'
import {
  attachPluginEditorGuest,
  closePluginEditorGuest,
  isAdmissiblePluginEditorAttach,
  openPluginEditorGuest,
  resetPluginEditorGuestsForTests
} from './plugin-editor-guests'

type FakeContents = EventEmitter & {
  id: number
  sent: unknown[]
  url: string
  ipc: EventEmitter
}

let nextId = 1
function contents(): FakeContents {
  const emitter = new EventEmitter()
  const sent: unknown[] = []
  return Object.assign(emitter, {
    id: nextId++,
    sent,
    url: '',
    ipc: new EventEmitter(),
    send(channel: string, payload: unknown) {
      this.sent.push({ channel, payload })
    },
    isDestroyed: () => false,
    getURL() {
      return this.url
    },
    setWebRTCIPHandlingPolicy: vi.fn(),
    setWindowOpenHandler: vi.fn()
  })
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry calls only the members the fake defines.
const asContents = (fake: FakeContents) => fake as unknown as Electron.WebContents

async function open(host: FakeContents, readonly: boolean) {
  return openPluginEditorGuest(asContents(host), {
    html: '<html class="__ORCA_COLOR_SCHEME__"><main>editor</main>',
    readonly,
    colorScheme: 'dark',
    tokens: '--orca-background:#000'
  })
}

function guestOf(host: FakeContents, src: string): FakeContents {
  const guest = contents()
  guest.url = src
  attachPluginEditorGuest(asContents(guest), asContents(host))
  return guest
}

const post = (guest: FakeContents, data: unknown) =>
  guest.ipc.emit(PLUGIN_EDITOR_GUEST_POST_CHANNEL, { sender: guest }, data)

afterEach(() => {
  resetPluginEditorGuestsForTests()
})

describe('plugin editor guests', () => {
  it('blackholes the editor session before any guest loads', async () => {
    await open(contents(), false)
    expect(fakeSession.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:9',
      proxyBypassRules: '<-loopback>'
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session policy registers exactly this request filter.
    const filter = fakeSession.webRequest.onBeforeRequest.mock.calls[0]?.[0] as (
      details: { url: string },
      callback: (response: { cancel: boolean }) => void
    ) => void
    const decide = (url: string) => {
      let cancel: boolean | undefined
      filter({ url }, (response) => (cancel = response.cancel))
      return cancel
    }
    expect(decide('https://example.com/')).toBe(true)
    expect(decide('ws://127.0.0.1:1/')).toBe(true)
    expect(decide(`orca-plugin-editor://${'a'.repeat(32)}/`)).toBe(false)
    expect(decide('data:image/png;base64,AA==')).toBe(false)
  })

  it('admits only a live guest of the same host into the editor partition', async () => {
    const host = contents()
    const ticket = await open(host, false)
    expect(
      isAdmissiblePluginEditorAttach(asContents(host), PLUGIN_EDITOR_PARTITION, ticket.src)
    ).toBe(true)
    expect(
      isAdmissiblePluginEditorAttach(asContents(contents()), PLUGIN_EDITOR_PARTITION, ticket.src)
    ).toBe(false)
    expect(isAdmissiblePluginEditorAttach(asContents(host), 'persist:other', ticket.src)).toBe(
      false
    )
    closePluginEditorGuest(asContents(host), ticket.token)
    expect(
      isAdmissiblePluginEditorAttach(asContents(host), PLUGIN_EDITOR_PARTITION, ticket.src)
    ).toBe(false)
  })

  it('reports save chords only from real input, read before the page sees it', async () => {
    const host = contents()
    const ticket = await open(host, false)
    const guest = guestOf(host, ticket.src)
    guest.emit(
      'before-input-event',
      {},
      {
        type: 'keyDown',
        key: 's',
        code: 'KeyS',
        meta: true,
        control: false,
        alt: false,
        shift: false,
        isAutoRepeat: false
      }
    )
    guest.emit(
      'before-input-event',
      {},
      {
        type: 'keyDown',
        key: 's',
        code: 'KeyS',
        meta: false,
        control: false,
        alt: false,
        shift: false,
        isAutoRepeat: false
      }
    )
    expect(host.sent).toEqual([
      {
        channel: PLUGIN_EDITOR_GUEST_EVENT_CHANNEL,
        payload: {
          token: ticket.token,
          kind: 'keydown',
          chord: {
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false
          }
        }
      }
    ])
  })

  it('ignores a guest whose URL names no live guest of its host', async () => {
    const host = contents()
    await open(host, false)
    const stray = guestOf(host, `orca-plugin-editor://${'f'.repeat(32)}/`)
    post(stray, { type: 'orca-editor-ready' })
    expect(host.sent).toEqual([])
  })

  it('pins the sandboxed preload literals to the shared protocol', () => {
    expect(PLUGIN_EDITOR_GUEST_POST).toBe(PLUGIN_EDITOR_GUEST_POST_CHANNEL)
    expect(PLUGIN_EDITOR_GUEST_DELIVER).toBe(PLUGIN_EDITOR_GUEST_DELIVER_CHANNEL)
    expect([...PLUGIN_EDITOR_HOST_MESSAGE_TYPES].sort()).toEqual(
      [
        CUSTOM_EDITOR_DOCUMENT_TYPE,
        CUSTOM_EDITOR_FLUSH_TYPE,
        CUSTOM_EDITOR_EDIT_REJECTED_TYPE,
        PANEL_PING_TYPE,
        PANEL_THEME_TYPE
      ].sort()
    )
  })
})
