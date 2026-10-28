import type { IpcRenderer, WebFrame } from 'electron'

// Raw require keeps this sandboxed preload standalone in the main-process CJS build.
const electron: { ipcRenderer: IpcRenderer; webFrame: WebFrame } = require('electron')
const { ipcRenderer, webFrame } = electron

ipcRenderer.once('browser-extension-native-page:execute', async (_event, code: string) => {
  try {
    const value = await webFrame.executeJavaScript(code)
    ipcRenderer.send('browser-extension-native-page:reply', null, value)
  } catch (error) {
    ipcRenderer.send('browser-extension-native-page:reply', error)
  }
})
