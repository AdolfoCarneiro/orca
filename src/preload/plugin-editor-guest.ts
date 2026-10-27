import {
  PLUGIN_EDITOR_GUEST_DELIVER,
  PLUGIN_EDITOR_GUEST_POST,
  PLUGIN_EDITOR_HOST_MESSAGE_TYPES
} from './plugin-editor-guest-channels'

// Preload for custom editor guests. It stays in the isolated world, so editor code can neither
// reach ipcRenderer nor send anything but the messages this relays to main.
// Raw require keeps the sandboxed preload standalone in the CJS build.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a sandboxed preload's require('electron') exposes ipcRenderer with these methods.
const { ipcRenderer } = require('electron') as {
  ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => void
    on: (channel: string, listener: (event: unknown, message: unknown) => void) => void
  }
}

const hostTypes = new Set(PLUGIN_EDITOR_HOST_MESSAGE_TYPES)

// Editors post to `window.parent`, which is the guest window itself at the top level.
window.addEventListener('message', (event) => {
  const data: unknown = event.data
  if (event.source !== window || typeof data !== 'object' || data === null) {
    return
  }
  const type = 'type' in data ? data.type : undefined
  if (typeof type === 'string' && !hostTypes.has(type)) {
    ipcRenderer.send(PLUGIN_EDITOR_GUEST_POST, data)
  }
})

ipcRenderer.on(PLUGIN_EDITOR_GUEST_DELIVER, (_event, message) => {
  window.postMessage(message, '*')
})
