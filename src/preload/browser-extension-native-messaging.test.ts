import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionInvokeReply } from './browser-extension-main-world'
import {
  installBrowserExtensionNativeMessaging,
  PRELOAD_NATIVE_MESSAGING_NAMESPACE,
  type BrowserExtensionNativeMessagingContext
} from './browser-extension-native-messaging'

type Reply = BrowserExtensionInvokeReply
type Call = { method: string; args: unknown[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** Calls `path` (e.g. 'onMessage.addListener') on `owner` with its parent as `this`. */
function call(owner: unknown, path: string, ...args: unknown[]): unknown {
  const keys = path.split('.')
  const leaf = keys.pop() ?? ''
  const parent = keys.reduce<unknown>(
    (value, key) => (isRecord(value) ? value[key] : undefined),
    owner
  )
  const fn = isRecord(parent) ? parent[leaf] : undefined
  if (typeof fn !== 'function') {
    throw new Error(`${path} is not a function`)
  }
  return fn.apply(parent, args)
}

/** Runs the installer from its source text, as contextBridge.executeInMainWorld does. */
function install(
  permissions: Record<string, string[]>,
  context: BrowserExtensionNativeMessagingContext = 'page',
  onPost?: (id: string, json: string) => void
) {
  const runtime: Record<string, unknown> = { getManifest: () => permissions }
  const browserRuntime: Record<string, unknown> = {}
  const calls: Call[] = []
  const listens: unknown[][] = []
  const pending = new Map<string, (reply: Reply) => void>()
  let dispatch: ((namespace: string, event: string, args: unknown[]) => void) | null = null
  const bridge = {
    call: (namespace: string, method: string, args: unknown[]) => {
      expect(namespace).toBe(PRELOAD_NATIVE_MESSAGING_NAMESPACE)
      calls.push({ method, args })
      const [id, json] = args
      if (method === 'postMessage' && typeof id === 'string' && typeof json === 'string') {
        onPost?.(id, json)
      }
      return new Promise<Reply>((resolve) => pending.set(`${method}:${String(args[0])}`, resolve))
    },
    listen: (namespace: string, event: string, active: boolean) =>
      listens.push([namespace, event, active]),
    onEvent: (handler: typeof dispatch) => {
      dispatch = handler
    },
    passesFilter: () => true
  }
  const error = vi.fn()
  const realm = {
    chrome: { runtime },
    browser: { runtime: browserRuntime },
    console: { error },
    JSON,
    Math,
    Date,
    Promise,
    TextEncoder
  }
  runInNewContext(`(${installBrowserExtensionNativeMessaging.toString()})(bridge, context)`, {
    ...realm,
    globalThis: realm,
    bridge,
    context
  })
  return {
    runtime,
    browserRuntime,
    calls,
    listens,
    error,
    /** The id the installer chose for the n-th call's port. */
    portId: (index = 0) => String(calls[index]?.args[0]),
    lastError: () => (isRecord(runtime.lastError) ? runtime.lastError.message : undefined),
    reply: (key: string, value: Reply) => pending.get(key)?.(value),
    emit: (args: unknown[]) => dispatch?.(PRELOAD_NATIVE_MESSAGING_NAMESPACE, 'onPortEvent', args)
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('chrome.runtime native messaging in extension contexts', () => {
  it('exists only for extensions that ask for nativeMessaging, on chrome and browser', () => {
    expect(install({ permissions: ['storage'] }).runtime.connectNative).toBeUndefined()
    const optional = install({ optional_permissions: ['nativeMessaging'] })
    expect(typeof optional.runtime.connectNative).toBe('function')
    expect(optional.browserRuntime.sendNativeMessage).toBe(optional.runtime.sendNativeMessage)
  })

  it('queues posts until the host runs and routes replies by port', async () => {
    const page = install({ permissions: ['nativeMessaging'] })
    const port = call(page.runtime, 'connectNative', 'com.example.vault')
    const received: unknown[][] = []
    call(port, 'onMessage.addListener', (message: unknown, from: unknown) =>
      received.push([message, from === port])
    )
    call(port, 'postMessage', { hello: 'é' })
    expect(isRecord(port) && port.name).toBe('')
    const id = page.portId()
    expect(page.calls).toEqual([{ method: 'connect', args: [id, 'com.example.vault'] }])
    // A reply can beat the connect answer; it still reaches the port.
    page.emit([id, 'message', '{"early":true}'])
    page.reply(`connect:${id}`, { ok: true, value: undefined })
    await tick()
    expect(page.calls[1]).toEqual({ method: 'postMessage', args: [id, '{"hello":"é"}'] })
    page.emit(['another-port', 'message', '{"stray":1}'])
    expect(received).toEqual([[{ early: true }, true]])
    expect(page.listens).toEqual([])
  })

  it('fires onDisconnect with runtime.lastError set only during the call', async () => {
    const page = install({ permissions: ['nativeMessaging'] })
    const port = call(page.runtime, 'connectNative', 'com.example.missing')
    const seen: unknown[] = []
    call(port, 'onDisconnect.addListener', () => seen.push(page.lastError()))
    page.reply(`connect:${page.portId()}`, {
      ok: false,
      error: 'Specified native messaging host not found.'
    })
    await tick()
    expect(seen).toEqual(['Specified native messaging host not found.'])
    expect(page.runtime.lastError).toBeUndefined()
    expect(() => call(port, 'postMessage', 1)).toThrow(
      'Attempting to use a disconnected port object'
    )
  })

  it('logs an unchecked lastError when nobody listens for the disconnect', async () => {
    const page = install({ permissions: ['nativeMessaging'] })
    call(page.runtime, 'connectNative', 'com.example.vault')
    page.reply(`connect:${page.portId()}`, { ok: true, value: undefined })
    await tick()
    page.emit([page.portId(), 'disconnect', 'Native host has exited.'])
    expect(page.error).toHaveBeenCalledWith('Unchecked runtime.lastError: Native host has exited.')
  })

  it('lets main release a port the extension dropped while it was starting', async () => {
    const worker = install({ permissions: ['nativeMessaging'] }, 'worker')
    const port = call(worker.runtime, 'connectNative', 'com.example.vault')
    expect(worker.listens).toEqual([[PRELOAD_NATIVE_MESSAGING_NAMESPACE, 'onPortEvent', true]])
    call(port, 'disconnect')
    worker.reply(`connect:${worker.portId()}`, { ok: true, value: undefined })
    await tick()
    expect(worker.calls.at(-1)).toEqual({ method: 'disconnect', args: [worker.portId()] })
  })

  it('registers a worker for port events on every connect, so a refusal before a grant is retried', () => {
    const worker = install({ optional_permissions: ['nativeMessaging'] }, 'worker')
    call(worker.runtime, 'connectNative', 'com.example.vault')
    call(worker.runtime, 'connectNative', 'com.example.vault')
    const listen = [PRELOAD_NATIVE_MESSAGING_NAMESPACE, 'onPortEvent', true]
    expect(worker.listens).toEqual([listen, listen])
  })

  it('answers sendNativeMessage with a promise, or a callback that sees lastError', async () => {
    const page = install({ permissions: ['nativeMessaging'] })
    const promised = call(page.runtime, 'sendNativeMessage', 'com.example.vault', { q: 1 })
    expect(page.calls[0]).toEqual({
      method: 'sendNativeMessage',
      args: ['com.example.vault', '{"q":1}']
    })
    page.reply('sendNativeMessage:com.example.vault', { ok: true, value: '{"a":2}' })
    await expect(promised).resolves.toEqual({ a: 2 })

    const results: unknown[] = []
    call(page.runtime, 'sendNativeMessage', 'com.example.gone', 1, (response: unknown) =>
      results.push([response, page.lastError()])
    )
    await tick()
    page.reply('sendNativeMessage:com.example.gone', {
      ok: false,
      error: 'Native host has exited.'
    })
    await tick()
    expect(results).toEqual([[undefined, 'Native host has exited.']])
  })
})

function connect(page: ReturnType<typeof install>) {
  const port = call(page.runtime, 'connectNative', 'com.example.vault')
  const id = String(page.calls.at(-1)?.args[0])
  return { port, id }
}

function jsonStringOfBytes(bytes: number, character = 'a'): string {
  const width = Buffer.byteLength(character)
  const count = Math.floor((bytes - 2) / width)
  return character.repeat(count) + 'a'.repeat(bytes - 2 - count * width)
}

const MAX_BODY_BYTES = 64 * 1024 * 1024
const IO_ERROR = 'Error when communicating with the native messaging host.'

describe.each(['page', 'worker'] as const)('native startup admission in %s', (context) => {
  it('admits 256 entries, preserves serialization exceptions, and disconnects only the overflow', async () => {
    const page = install({ permissions: ['nativeMessaging'] }, context)
    const first = connect(page)
    const sibling = connect(page)
    const errors: unknown[] = []
    call(first.port, 'onDisconnect.addListener', () => errors.push(page.lastError()))
    for (let index = 0; index < 256; index++) {
      call(first.port, 'postMessage', index)
    }
    call(sibling.port, 'postMessage', 'healthy')
    const original = new Error('serialization failed')
    expect(() =>
      call(first.port, 'postMessage', {
        toJSON() {
          throw original
        }
      })
    ).toThrow(original)
    expect(errors).toEqual([])
    expect(page.calls.filter((entry) => entry.method === 'postMessage')).toEqual([])
    expect(call(first.port, 'postMessage', 256)).toBeUndefined()
    expect(errors).toEqual([IO_ERROR])
    expect(page.lastError()).toBeUndefined()
    expect(() => call(first.port, 'postMessage', 0)).toThrow('disconnected port object')
    call(first.port, 'disconnect')
    page.emit([first.id, 'disconnect', 'duplicate'])
    page.reply(`connect:${first.id}`, { ok: true, value: undefined })
    page.reply(`connect:${sibling.id}`, { ok: true, value: undefined })
    await tick()
    expect(errors).toEqual([IO_ERROR])
    expect(page.calls.filter((entry) => entry.method === 'disconnect')).toEqual([
      { method: 'disconnect', args: [first.id] }
    ])
    expect(page.calls.filter((entry) => entry.method === 'postMessage')).toEqual([
      { method: 'postMessage', args: [sibling.id, '"healthy"'] }
    ])
  })

  it('charges UTF-8 plus each framing header and releases the exact port byte budget', async () => {
    const page = install({ permissions: ['nativeMessaging'] }, context)
    const first = connect(page)
    const errors: unknown[] = []
    call(first.port, 'onDisconnect.addListener', () => errors.push(page.lastError()))
    call(first.port, 'postMessage', jsonStringOfBytes(MAX_BODY_BYTES / 2))
    call(first.port, 'postMessage', jsonStringOfBytes(MAX_BODY_BYTES / 2 - 4, 'é'))
    expect(errors).toEqual([])
    call(first.port, 'postMessage', 0)
    expect(errors).toEqual([IO_ERROR])
    const successor = connect(page)
    call(successor.port, 'postMessage', jsonStringOfBytes(MAX_BODY_BYTES, 'é'))
    page.reply(`connect:${first.id}`, { ok: true, value: undefined })
    page.reply(`connect:${successor.id}`, { ok: true, value: undefined })
    await tick()
    const posts = page.calls.filter((entry) => entry.method === 'postMessage')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.args[0]).toBe(successor.id)
    expect(Buffer.byteLength(String(posts[0]?.args[1]))).toBe(MAX_BODY_BYTES)
  })

  it('rejects a first body exceeding 64 MiB by UTF-8 bytes', async () => {
    const page = install({ permissions: ['nativeMessaging'] }, context)
    const first = connect(page)
    const errors: unknown[] = []
    call(first.port, 'onDisconnect.addListener', () => errors.push(page.lastError()))
    call(first.port, 'postMessage', jsonStringOfBytes(MAX_BODY_BYTES + 1, 'é'))
    expect(errors).toEqual([IO_ERROR])
    page.reply(`connect:${first.id}`, { ok: true, value: undefined })
    await tick()
    expect(page.calls.filter((entry) => entry.method === 'postMessage')).toEqual([])
    expect(page.calls.at(-1)).toEqual({ method: 'disconnect', args: [first.id] })
  })

  it('shares twice the port byte budget across ports and refunds explicit closure', async () => {
    const page = install({ permissions: ['nativeMessaging'] }, context)
    const first = connect(page)
    const sibling = connect(page)
    const message = jsonStringOfBytes(MAX_BODY_BYTES)
    call(first.port, 'postMessage', message)
    call(sibling.port, 'postMessage', message)
    const rejected = connect(page)
    const errors: unknown[] = []
    call(rejected.port, 'onDisconnect.addListener', () => errors.push(page.lastError()))
    call(rejected.port, 'postMessage', 0)
    expect(errors).toEqual([IO_ERROR])
    call(first.port, 'disconnect')
    call(first.port, 'disconnect')
    const successor = connect(page)
    call(successor.port, 'postMessage', message)
    for (const entry of [first, sibling, rejected, successor]) {
      page.reply(`connect:${entry.id}`, { ok: true, value: undefined })
    }
    await tick()
    const posts = page.calls.filter((entry) => entry.method === 'postMessage')
    expect(posts.map((entry) => entry.args[0])).toEqual([sibling.id, successor.id])
    expect(posts.map((entry) => Buffer.byteLength(String(entry.args[1])))).toEqual([
      MAX_BODY_BYTES,
      MAX_BODY_BYTES
    ])
    expect(page.calls.filter((entry) => entry.method === 'disconnect')).toEqual([
      { method: 'disconnect', args: [first.id] },
      { method: 'disconnect', args: [rejected.id] }
    ])
  })

  it('shares 1024 entries and releases an overflowing queue before reentrant admission', async () => {
    const page = install({ permissions: ['nativeMessaging'] }, context)
    const entries = Array.from({ length: 5 }, () => connect(page))
    const last = entries.at(-1)
    expect(last).toBeDefined()
    if (!last) {
      throw new Error('Missing final port')
    }
    for (const [index, entry] of entries.entries()) {
      for (let item = 0; item < (index < 4 ? 255 : 4); item++) {
        call(entry.port, 'postMessage', 0)
      }
    }
    let successor: ReturnType<typeof connect> | undefined
    const errors: unknown[] = []
    call(last.port, 'onDisconnect.addListener', () => {
      errors.push(page.lastError())
      successor = connect(page)
      for (let index = 0; index < 4; index++) {
        call(successor.port, 'postMessage', 0)
      }
    })
    call(last.port, 'postMessage', 0)
    expect(errors).toEqual([IO_ERROR])
    expect(successor).toBeDefined()
    if (!successor) {
      throw new Error('Missing reentrant successor')
    }
    const successorId = successor.id
    for (const entry of [...entries, successor]) {
      page.reply(`connect:${entry.id}`, { ok: true, value: undefined })
    }
    await tick()
    const posts = page.calls.filter((entry) => entry.method === 'postMessage')
    expect(posts).toHaveLength(1024)
    expect(posts.filter((entry) => entry.args[0] === last.id)).toEqual([])
    expect(posts.filter((entry) => entry.args[0] === successorId)).toHaveLength(4)
    expect(page.calls.filter((entry) => entry.method === 'disconnect')).toEqual([
      { method: 'disconnect', args: [last.id] }
    ])
  })

  it('keeps reentrant posts behind the remaining FIFO drain', async () => {
    const page = install({ permissions: ['nativeMessaging'] }, context, (_id, json) => {
      if (json === '"first"') {
        call(first.port, 'postMessage', 'third')
      }
    })
    const first = connect(page)
    call(first.port, 'postMessage', 'first')
    call(first.port, 'postMessage', 'second')
    page.reply(`connect:${first.id}`, { ok: true, value: undefined })
    await tick()
    expect(
      page.calls.filter((entry) => entry.method === 'postMessage').map((entry) => entry.args[1])
    ).toEqual(['"first"', '"second"', '"third"'])
  })

  it('keeps all but the handed-off entry charged during a reentrant bridge call', async () => {
    let admitted: ReturnType<typeof connect> | undefined
    let rejected: ReturnType<typeof connect> | undefined
    const errors: unknown[] = []
    const page = install({ permissions: ['nativeMessaging'] }, context, () => {
      if (admitted) {
        return
      }
      admitted = connect(page)
      call(admitted.port, 'postMessage', 0)
      rejected = connect(page)
      call(rejected.port, 'onDisconnect.addListener', () => errors.push(page.lastError()))
      call(rejected.port, 'postMessage', 0)
    })
    const entries = Array.from({ length: 4 }, () => connect(page))
    for (const entry of entries) {
      for (let index = 0; index < 256; index++) {
        call(entry.port, 'postMessage', index)
      }
    }
    const first = entries[0]
    if (!first) {
      throw new Error('Missing draining port')
    }
    page.reply(`connect:${first.id}`, { ok: true, value: undefined })
    await tick()
    expect(errors).toEqual([IO_ERROR])
    if (!admitted || !rejected) {
      throw new Error('Missing reentrant ports')
    }
    const admittedId = admitted.id
    const rejectedId = rejected.id
    for (const entry of [...entries.slice(1), admitted, rejected]) {
      page.reply(`connect:${entry.id}`, { ok: true, value: undefined })
    }
    await tick()
    const posts = page.calls.filter((entry) => entry.method === 'postMessage')
    expect(posts).toHaveLength(1025)
    expect(
      posts
        .filter((entry) => entry.args[0] === first.id)
        .map((entry) => JSON.parse(String(entry.args[1])))
    ).toEqual(Array.from({ length: 256 }, (_, index) => index))
    expect(posts.filter((entry) => entry.args[0] === admittedId)).toHaveLength(1)
    expect(posts.filter((entry) => entry.args[0] === rejectedId)).toHaveLength(0)
  })

  it('disconnects main once when overflow occurs during the drain', async () => {
    let overflowed = false
    const page = install({ permissions: ['nativeMessaging'] }, context, () => {
      if (!overflowed) {
        overflowed = true
        call(first.port, 'postMessage', 'fills the released slot')
        call(first.port, 'postMessage', 'overflows the port')
      }
    })
    const first = connect(page)
    const errors: unknown[] = []
    call(first.port, 'onDisconnect.addListener', () => {
      errors.push(page.lastError())
      call(first.port, 'disconnect')
    })
    for (let index = 0; index < 256; index++) {
      call(first.port, 'postMessage', index)
    }
    page.reply(`connect:${first.id}`, { ok: true, value: undefined })
    await tick()
    expect(errors).toEqual([IO_ERROR])
    expect(page.calls.filter((entry) => entry.method === 'postMessage')).toEqual([
      { method: 'postMessage', args: [first.id, '0'] }
    ])
    expect(page.calls.filter((entry) => entry.method === 'disconnect')).toEqual([
      { method: 'disconnect', args: [first.id] }
    ])
  })

  it('does not resurrect a port closed inside toJSON and preserves a serialization throw', async () => {
    const page = install({ permissions: ['nativeMessaging'] }, context)
    const first = connect(page)
    call(first.port, 'postMessage', 'queued')
    expect(() =>
      call(first.port, 'postMessage', {
        toJSON() {
          call(first.port, 'disconnect')
          return 'closed'
        }
      })
    ).toThrow('disconnected port object')
    const second = connect(page)
    const original = new Error('throws after closing')
    expect(() =>
      call(second.port, 'postMessage', {
        toJSON() {
          call(second.port, 'disconnect')
          throw original
        }
      })
    ).toThrow(original)
    for (const entry of [first, second]) {
      page.reply(`connect:${entry.id}`, { ok: true, value: undefined })
    }
    await tick()
    expect(page.calls.filter((entry) => entry.method === 'postMessage')).toEqual([])
    expect(page.calls.filter((entry) => entry.method === 'disconnect')).toHaveLength(2)
  })

  it.each(['extension', 'host'] as const)(
    'stops the remaining drain after %s closure',
    async (source) => {
      const errors: unknown[] = []
      const page = install({ permissions: ['nativeMessaging'] }, context, () => {
        if (source === 'extension') {
          call(first.port, 'disconnect')
          call(first.port, 'disconnect')
        } else {
          page.emit([first.id, 'disconnect', 'host ended'])
          page.emit([first.id, 'disconnect', 'duplicate'])
        }
      })
      const first = connect(page)
      call(first.port, 'onDisconnect.addListener', () => errors.push(page.lastError()))
      call(first.port, 'postMessage', 1)
      call(first.port, 'postMessage', 2)
      page.reply(`connect:${first.id}`, { ok: true, value: undefined })
      await tick()
      expect(page.calls.filter((entry) => entry.method === 'postMessage')).toEqual([
        { method: 'postMessage', args: [first.id, '1'] }
      ])
      expect(errors).toEqual(source === 'host' ? ['host ended'] : [])
      expect(page.calls.filter((entry) => entry.method === 'disconnect')).toHaveLength(
        source === 'extension' ? 1 : 0
      )
    }
  )
})
