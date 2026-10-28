import { MessageChannelMain } from 'electron'
import { BROWSER_EXTENSION_POPUP_SIZE_CHANNEL } from '../../../shared/browser-extension-channels'
import { abortWhenRendererGone } from '../../ipc/renderer-lifetime-abort'
import { BROWSER_EXTENSION_POPUP_MAX } from './browser-extension-popup-geometry'

type Size = { width: number; height: number }

export function parseBrowserExtensionPopupSize(value: unknown): Size | null {
  if (typeof value !== 'object' || value === null || !('width' in value) || !('height' in value)) {
    return null
  }
  const { width, height } = value
  return typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(width) &&
    Number.isFinite(height)
    ? { width, height }
    : null
}

export function watchBrowserExtensionPopupSize(
  contents: Electron.WebContents,
  options: {
    apply: (size: Size) => void
    setReady: (ready: boolean) => void
  }
): () => void {
  let current: { dispose: () => void } | undefined
  let generation = 0
  let disposed = false

  const stopDocument = (): void => {
    const previous = current
    current = undefined
    options.setReady(false)
    previous?.dispose()
  }
  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    contents.removeListener('dom-ready', startDocument)
    contents.removeListener('did-navigate', stopDocument)
    contents.removeListener('destroyed', dispose)
    contents.removeListener('render-process-gone', stopDocument)
    stopDocument()
  }
  const startDocument = (): void => {
    stopDocument()
    if (disposed || contents.isDestroyed()) {
      return
    }
    const token = ++generation
    let retired = false
    let release = (): void => {}
    const owner = {
      dispose: (): void => {
        if (retired) {
          return
        }
        retired = true
        release()
      }
    }
    current = owner
    try {
      const { port1, port2 } = new MessageChannelMain()
      release = () => {
        port1.close()
        port2.close()
      }
      const lifetime = abortWhenRendererGone(contents)
      let transferred = false
      const retire = (): void => {
        if (current === owner) {
          stopDocument()
        }
      }
      const onMessage = ({ data }: Electron.MessageEvent): void => {
        if (retired || current !== owner || contents.isDestroyed()) {
          return
        }
        if (data === null) {
          options.setReady(true)
          return
        }
        const size = parseBrowserExtensionPopupSize(data)
        if (!size) {
          return
        }
        options.apply(size)
        if (!retired && current === owner) {
          options.setReady(true)
        }
      }
      release = () => {
        lifetime.signal.removeEventListener('abort', retire)
        lifetime.dispose()
        port1.removeListener('message', onMessage)
        port1.removeListener('close', retire)
        if (!contents.isDestroyed()) {
          try {
            contents.send(BROWSER_EXTENSION_POPUP_SIZE_CHANNEL, { generation: token })
          } catch {
            // The renderer may have exited before its destruction event.
          }
        }
        port1.close()
        if (!transferred) {
          port2.close()
        }
      }
      lifetime.signal.addEventListener('abort', retire, { once: true })
      port1.on('message', onMessage)
      port1.once('close', retire)
      port1.start()
      contents.mainFrame.postMessage(
        BROWSER_EXTENSION_POPUP_SIZE_CHANNEL,
        { generation: token, maxWidth: BROWSER_EXTENSION_POPUP_MAX.width },
        [port2]
      )
      transferred = true
    } catch {
      if (current !== owner) {
        owner.dispose()
        return
      }
      stopDocument()
      // Preserve the initial-bounds fallback when this document cannot be measured.
      if (!disposed && !contents.isDestroyed()) {
        options.setReady(true)
      }
    }
  }

  if (contents.isDestroyed()) {
    return dispose
  }
  contents.on('dom-ready', startDocument)
  contents.on('did-navigate', stopDocument)
  contents.once('destroyed', dispose)
  contents.on('render-process-gone', stopDocument)
  return dispose
}
