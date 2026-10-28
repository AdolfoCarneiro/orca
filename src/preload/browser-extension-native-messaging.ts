import type { BrowserExtensionMainWorldBridge } from './browser-extension-main-world'
import type * as NativePort from './browser-extension-native-messaging-types'

/** Main-only namespace behind connectNative/sendNativeMessage; never installed on `chrome`. */
export const PRELOAD_NATIVE_MESSAGING_NAMESPACE = 'orcaNativeMessaging'

export type BrowserExtensionNativeMessagingContext = 'page' | 'worker'

type ApiObject = Record<string, unknown>

/**
 * Installs chrome.runtime.connectNative and sendNativeMessage for extensions that declare
 * "nativeMessaging". Main starts the host and routes its messages to this context only, by a port
 * id chosen here so events that beat the connect reply still find their port.
 *
 * Self-contained for the same reason as installBrowserExtensionApis: pages serialize it.
 */
export function installBrowserExtensionNativeMessaging(
  bridge: BrowserExtensionMainWorldBridge,
  context: BrowserExtensionNativeMessagingContext
): void {
  const namespace = 'orcaNativeMessaging'
  const portEvent = 'onPortEvent'
  const disconnectedError = 'Attempting to use a disconnected port object'
  const ioError = 'Error when communicating with the native messaging host.'
  const headerBytes = 4
  const maxMessageBytes = 64 * 1024 * 1024
  const maxPortBytes = maxMessageBytes + headerBytes
  const maxContextBytes = 2 * maxPortBytes
  const maxPortMessages = 256
  const maxContextMessages = 1024
  const isObject = (value: unknown): value is ApiObject =>
    value !== null && typeof value === 'object'
  const isCallable = (value: unknown): value is NativePort.Listener => typeof value === 'function'
  const root: { chrome?: unknown; browser?: unknown } = globalThis
  const chromeApi = root.chrome
  const runtime = isObject(chromeApi) && isObject(chromeApi.runtime) ? chromeApi.runtime : null
  if (!runtime) {
    return
  }
  let manifest: unknown = null
  try {
    const getManifest = runtime.getManifest
    manifest = isCallable(getManifest) ? getManifest.call(runtime) : null
  } catch {
    manifest = null
  }
  // Why optional too: Chrome adds a granted API without a reload; main refuses calls until granted.
  const declared = isObject(manifest)
    ? [manifest.permissions, manifest.optional_permissions].flatMap((list) =>
        Array.isArray(list) ? list : []
      )
    : []
  if (!declared.includes('nativeMessaging')) {
    return
  }

  const callWithLastError = (message: string | null, callback: () => void): void => {
    let defined = false
    if (message !== null) {
      try {
        Object.defineProperty(runtime, 'lastError', {
          configurable: true,
          get: () => ({ message })
        })
        defined = true
      } catch {
        // Native lastError cannot be replaced here; the callback still runs.
      }
    }
    try {
      callback()
    } finally {
      if (defined) {
        try {
          delete runtime.lastError
        } catch {
          // ignore
        }
      }
    }
  }
  const serialize = (message: unknown): string => {
    const json: unknown = JSON.stringify(message)
    if (typeof json !== 'string') {
      throw new Error('Could not serialize message.')
    }
    return json
  }
  const makeEvent = () => {
    const listeners = new Set<NativePort.Listener>()
    return {
      listeners,
      api: {
        addListener: (callback: unknown) => {
          if (isCallable(callback)) {
            listeners.add(callback)
          }
        },
        removeListener: (callback: unknown) => {
          if (isCallable(callback)) {
            listeners.delete(callback)
          }
        },
        hasListener: (callback: unknown) => isCallable(callback) && listeners.has(callback),
        hasListeners: () => listeners.size > 0
      }
    }
  }
  const dispatch = (listeners: Set<NativePort.Listener>, args: unknown[]): void => {
    for (const listener of listeners) {
      try {
        listener(...args)
      } catch (error) {
        console.error(error)
      }
    }
  }

  let utf8Encoder: TextEncoder | undefined
  let utf8Scratch: Uint8Array | undefined
  const measureQueuedBytes = (json: string, limit: number): number => {
    if (json.length > limit) {
      return limit + 1
    }
    utf8Encoder ??= new TextEncoder()
    utf8Scratch ??= new Uint8Array(64 * 1024)
    let read = 0
    let bytes = 0
    while (read < json.length && bytes <= limit) {
      const chunk = utf8Encoder.encodeInto(read === 0 ? json : json.slice(read), utf8Scratch)
      read += chunk.read
      bytes += chunk.written
    }
    return bytes
  }

  const ports = new Map<string, NativePort.State>()
  let counter = 0
  let queuedContextBytes = 0
  let queuedContextMessages = 0

  const requireConnected = (entry: NativePort.State): void => {
    if (entry.state === 'closed') {
      throw new Error(disconnectedError)
    }
  }

  const endPort: NativePort.EndPort = (id, entry, error, closeMain = false) => {
    if (entry.state === 'closed') {
      return
    }
    const wasOpen = entry.state === 'open'
    entry.state = 'closed'
    queuedContextBytes -= entry.queuedBytes
    queuedContextMessages -= entry.queued.length
    entry.queuedBytes = 0
    entry.queued.length = 0
    ports.delete(id)
    if (error !== undefined) {
      if (entry.onDisconnect.size === 0) {
        console.error(`Unchecked runtime.lastError: ${error}`)
      }
      callWithLastError(error, () => dispatch(entry.onDisconnect, [entry.port]))
    }
    if (wasOpen && closeMain) {
      void bridge.call(namespace, 'disconnect', [id])
    }
  }

  bridge.onEvent((eventNamespace, event, args) => {
    if (eventNamespace !== namespace || event !== portEvent) {
      return
    }
    const [id, kind, data] = args
    const entry = typeof id === 'string' ? ports.get(id) : undefined
    if (!entry || typeof id !== 'string' || typeof data !== 'string') {
      return
    }
    if (kind === 'message') {
      let message: unknown
      try {
        message = JSON.parse(data)
      } catch {
        return
      }
      dispatch(entry.onMessage, [message, entry.port])
    } else if (kind === 'disconnect') {
      endPort(id, entry, data)
    }
  })

  const connectNative = (application: unknown): ApiObject => {
    if (typeof application !== 'string') {
      throw new TypeError(
        'Error in invocation of runtime.connectNative(string application): No matching signature.'
      )
    }
    // Why every connect: main refuses the listen until an optional permission is granted, and
    // a repeated listen is a no-op.
    if (context === 'worker') {
      bridge.listen(namespace, portEvent, true)
    }
    counter += 1
    const id = `${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2)}`
    const onMessage = makeEvent()
    const onDisconnect = makeEvent()
    const port: ApiObject = {}
    const entry: NativePort.State = {
      state: 'starting',
      queued: [],
      queuedBytes: 0,
      draining: false,
      onMessage: onMessage.listeners,
      onDisconnect: onDisconnect.listeners,
      port
    }
    Object.assign(port, {
      name: '',
      sender: undefined,
      onMessage: onMessage.api,
      onDisconnect: onDisconnect.api,
      postMessage: (message: unknown) => {
        requireConnected(entry)
        const json = serialize(message)
        requireConnected(entry)
        if (entry.state === 'starting' || entry.draining) {
          const limit = Math.min(
            maxMessageBytes,
            maxPortBytes - entry.queuedBytes - headerBytes,
            maxContextBytes - queuedContextBytes - headerBytes
          )
          const bodyBytes =
            entry.queued.length >= maxPortMessages || queuedContextMessages >= maxContextMessages
              ? limit + 1
              : measureQueuedBytes(json, limit)
          if (bodyBytes > limit) {
            endPort(id, entry, ioError, true)
            return
          }
          const bytes = headerBytes + bodyBytes
          entry.queued.push({ json, bytes })
          entry.queuedBytes += bytes
          queuedContextBytes += bytes
          queuedContextMessages += 1
        } else {
          void bridge.call(namespace, 'postMessage', [id, json])
        }
      },
      disconnect: () => endPort(id, entry, undefined, true)
    })
    ports.set(id, entry)
    void bridge.call(namespace, 'connect', [id, application]).then((reply) => {
      if (!reply.ok) {
        endPort(id, entry, reply.error)
        return
      }
      if (entry.state === 'closed') {
        // Disconnected (by the extension or the host) while starting: make sure main lets go.
        void bridge.call(namespace, 'disconnect', [id])
        return
      }
      entry.state = 'open'
      entry.draining = true
      while (entry.queued.length > 0) {
        const queued = entry.queued.shift()
        if (!queued) {
          break
        }
        entry.queuedBytes -= queued.bytes
        queuedContextBytes -= queued.bytes
        queuedContextMessages -= 1
        void bridge.call(namespace, 'postMessage', [id, queued.json])
      }
      entry.draining = false
    })
    return port
  }

  const sendNativeMessage = (application: unknown, message: unknown, callback?: unknown) => {
    const done = isCallable(callback) ? callback : null
    const run = async (): Promise<unknown> => {
      if (typeof application !== 'string') {
        throw new Error('Invalid native messaging host name specified.')
      }
      const reply = await bridge.call(namespace, 'sendNativeMessage', [
        application,
        serialize(message)
      ])
      if (!reply.ok) {
        throw new Error(reply.error)
      }
      return typeof reply.value === 'string' ? JSON.parse(reply.value) : undefined
    }
    const promise = run()
    if (!done) {
      return promise
    }
    promise.then(
      (value) => done(value),
      (error: unknown) =>
        callWithLastError(error instanceof Error ? error.message : String(error), () => done())
    )
    return undefined
  }

  const define = (target: ApiObject, key: string, value: unknown): void => {
    try {
      Object.defineProperty(target, key, {
        value,
        configurable: true,
        enumerable: true,
        writable: true
      })
    } catch {
      // Frozen native object: leave it.
    }
  }
  // Why `browser` too: it is a separate native global that WebExtension-style code reads first.
  const targets = [runtime]
  const browserRuntime = isObject(root.browser) ? root.browser.runtime : null
  if (isObject(browserRuntime) && browserRuntime !== runtime) {
    targets.push(browserRuntime)
  }
  for (const target of targets) {
    define(target, 'connectNative', connectNative)
    define(target, 'sendNativeMessage', sendNativeMessage)
  }
}
