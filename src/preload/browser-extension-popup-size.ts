import type { IpcRenderer } from 'electron'
import { PRELOAD_BROWSER_EXTENSION_POPUP_SIZE_CHANNEL } from './browser-extension-api-surface'

export function installBrowserExtensionPopupSize(ipcRenderer: IpcRenderer): void {
  let generation: number | undefined
  let dispose = (): void => {}
  ipcRenderer.on(PRELOAD_BROWSER_EXTENSION_POPUP_SIZE_CHANNEL, (event, data: unknown) => {
    const [port, ...surplus] = event.ports
    for (const extra of surplus) {
      extra.close()
    }
    if (
      !data ||
      typeof data !== 'object' ||
      !('generation' in data) ||
      typeof data.generation !== 'number'
    ) {
      port?.close()
      return
    }
    if (!port) {
      if (generation === data.generation) {
        dispose()
      }
      return
    }
    dispose()
    if (
      !('maxWidth' in data) ||
      typeof data.maxWidth !== 'number' ||
      !Number.isFinite(data.maxWidth) ||
      data.maxWidth <= 0
    ) {
      port.close()
      return
    }
    generation = data.generation
    const maxWidth = data.maxWidth
    let active = true
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let reported = ''
    const measureAt = (width: string): DOMRect => {
      const sheet = new CSSStyleSheet()
      const quirks = document.compatMode === 'BackCompat'
      sheet.replaceSync(
        `html{box-sizing:border-box!important;min-width:0!important;max-width:none!important;width:${
          width
        }!important}${quirks ? 'html,body{height:fit-content!important}' : ''}`
      )
      const sheets = document.adoptedStyleSheets
      sheets.push(sheet)
      try {
        return document.documentElement.getBoundingClientRect()
      } finally {
        sheets.splice(sheets.indexOf(sheet), 1)
      }
    }
    const update = (): void => {
      timer = undefined
      if (!active || !document.documentElement) {
        return
      }
      try {
        const fit = measureAt('min-content')
        const width = Math.ceil(fit.width)
        const rect = width > maxWidth ? measureAt(`${maxWidth}px`) : fit
        const size = { width, height: Math.ceil(rect.height) }
        const key = `${size.width}x${size.height}`
        if (key === reported) {
          return
        }
        reported = key
        port.postMessage(size)
      } catch {
        stopObserving()
        port.postMessage(null)
      }
    }
    const schedule = (): void => {
      if (active && timer === undefined) {
        timer = setTimeout(update, 50)
      }
    }
    const mutations = new MutationObserver(schedule)
    const resizes = new ResizeObserver(schedule)
    const stopObserving = (): void => {
      if (!active) {
        return
      }
      active = false
      clearTimeout(timer)
      mutations.disconnect()
      resizes.disconnect()
      window.removeEventListener('load', schedule)
    }
    dispose = () => {
      if (closed) {
        return
      }
      closed = true
      stopObserving()
      port.close()
    }
    mutations.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    })
    resizes.observe(document.documentElement)
    if (document.body) {
      resizes.observe(document.body)
    }
    window.addEventListener('load', schedule)
    if (document.fonts) {
      void document.fonts.ready.then(schedule)
    }
    port.start()
    update()
  })
}
