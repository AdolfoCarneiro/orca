import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import type * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import type { applyAgentStatusHooksEnabled as ApplyManagedHooks } from '../agent-hooks/managed-agent-hook-controls'
const seam = vi.hoisted(
  (): {
    home: string
    before: null | ((method: string, path: string) => Promise<void>)
    after: null | ((method: string, path: string) => Promise<void>)
    calls: Map<string, number> | null
    bytes: Map<string, number> | null
    probes: number
    online: boolean
  } => ({ home: '', before: null, after: null, calls: null, bytes: null, probes: 0, online: true })
)
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof childProcess>()
  const originalAsync = promisify(actual.execFile)
  const execFile = (...args: unknown[]) => {
    seam.probes++
    return Reflect.apply(actual.execFile, undefined, args)
  }
  Object.defineProperty(execFile, promisify.custom, {
    value: (...args: unknown[]) => {
      seam.probes++
      return Reflect.apply(originalAsync, undefined, args)
    }
  })
  return { ...actual, execFile }
})
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  homedir: () => seam.home
}))
vi.mock('electron', () => ({ app: { getPath: () => seam.home } }))
vi.mock('../agent-hooks/local-agent-cli-presence', () => ({
  detectLocalManagedAgentCliPresence: async () => ({
    claude: { state: 'found' },
    gemini: { state: 'found' }
  })
}))
vi.mock('../../cli/runtime-client', () => ({
  RuntimeClient: class {
    getCliStatus = async () => ({
      result: { runtime: { reachable: seam.online }, app: { running: seam.online } }
    })
    call = async () => ({ result: { settings: {} } })
  },
  RuntimeClientError: Error,
  getDefaultUserDataPath: () => join(seam.home, 'data')
}))
vi.mock('../../cli/profile-state-location', () => ({
  getActiveProfileStateLocation: () => undefined
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    ...Object.fromEntries(
      (
        [
          'readFile',
          'realpath',
          'stat',
          'lstat',
          'rename',
          'rm',
          'writeFile',
          'readdir',
          'link',
          'copyFile'
        ] as const
      ).map((method) => [
        method,
        async (...args: unknown[]) => {
          const path = String(
            method === 'rename' || method === 'link' || method === 'copyFile' ? args[1] : args[0]
          )
          seam.calls?.set(`${method}:${path}`, (seam.calls.get(`${method}:${path}`) ?? 0) + 1)
          await seam.before?.(method, path)
          const result = await Reflect.apply(actual[method], undefined, args)
          const payload = method === 'readFile' ? result : method === 'writeFile' ? args[1] : null
          if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
            seam.bytes?.set(
              `${method}:${path}`,
              (seam.bytes.get(`${method}:${path}`) ?? 0) + Buffer.byteLength(payload)
            )
          }
          if (method === 'copyFile' && seam.bytes) {
            seam.bytes.set(
              `${method}:${path}`,
              (seam.bytes.get(`${method}:${path}`) ?? 0) + (await actual.stat(String(args[0]))).size
            )
          }
          await seam.after?.(method, path)
          return result
        }
      ])
    )
  }
})
import { ClaudeHookService } from './hook-service'
import { getStatusLineSlotState } from './hook-settings'
export async function applyAgentStatusHooksEnabled(...args: Parameters<typeof ApplyManagedHooks>) {
  return await (
    await import('../agent-hooks/managed-agent-hook-controls')
  ).applyAgentStatusHooksEnabled(...args)
}
export async function main(args: string[]) {
  return await (await import('../../cli/index')).main(args)
}
export function slot(config: Parameters<typeof getStatusLineSlotState>[0]) {
  return getStatusLineSlotState(config)
}
const current = { claudeVersion: '2.1.261' }
let Service = ClaudeHookService
const service = () => new Service()
const file = (name: string) => join(seam.home, name, 'settings.json')
const read = async (path: string) => JSON.parse(await fs.readFile(path, 'utf8'))
const write = async (path: string, config: object) => {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify(config))
}
const install = (name: string, options = current) =>
  service().installSystem({
    ...options,
    target: { kind: 'system-default', configDir: dirname(file(name)) }
  })
const remove = (name: string) =>
  service().removeSystem({ target: { kind: 'system-default', configDir: dirname(file(name)) } })
const erase = async (name: string) => {
  const config = await read(file(name))
  delete config.statusLine
  await write(file(name), config)
}
const storage = () => join(seam.home, '.orca/agent-hooks/claude-statusline')
const documentPath = async () =>
  join(
    storage(),
    (await fs.readdir(storage())).find((name) => name.endsWith('.json'))!
  )
const document = async () => read(await documentPath())
const failure = () => Object.assign(new Error('injected storage failure'), { code: 'EACCES' })
beforeEach(async () => {
  seam.online = true
  seam.home = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'pr31199-sl-')))
  vi.stubEnv('HOME', seam.home)
  vi.stubEnv('USERPROFILE', seam.home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  vi.stubEnv('ORCA_CLAUDE_INJECTED_CONFIG_DIR', '')
})
afterEach(async () => {
  seam.before = seam.after = null
  seam.calls = seam.bytes = null
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = undefined
  await fs.rm(seam.home, { recursive: true, force: true })
})

export {
  seam,
  current,
  service,
  file,
  read,
  write,
  install,
  remove,
  erase,
  storage,
  documentPath,
  document,
  failure
}
export async function resetService() {
  vi.resetModules()
  Service = (await import('./hook-service')).ClaudeHookService
}
