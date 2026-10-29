import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import type * as NodeOs from 'node:os'
import type * as CodexCommand from '../codex-cli/command'
import type * as TrustDerivation from '../codex/codex-hook-trust-derivation'
import type { CodexHookAnswer } from '../codex/codex-hook-trust-derivation'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createStore,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

const mocks = vi.hoisted(() => ({
  codexPath: '',
  blockedHookFile: '',
  readdirCalls: 0,
  metadataCalls: 0,
  writtenBytes: 0,
  probeCodexVersion: vi.fn<(codexPath: string) => Promise<string | null>>(),
  deriveCodexHookHashes: vi.fn()
}))

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      mocks.readdirCalls++
      return actual.readdirSync(...args)
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      mocks.metadataCalls++
      return actual.lstatSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      mocks.writtenBytes += Buffer.byteLength(String(args[1]))
      return actual.writeFileSync(...args)
    },
    renameSync: (source: string, destination: string) => {
      if (
        mocks.blockedHookFile &&
        basename(destination) === basename(mocks.blockedHookFile) &&
        actual.realpathSync(dirname(destination)) ===
          actual.realpathSync(dirname(mocks.blockedHookFile))
      ) {
        throw Object.assign(new Error('fixture locked hook file'), { code: 'EACCES' })
      }
      return actual.renameSync(source, destination)
    }
  }
})
vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => testState.fakeHomeDir
}))
vi.mock('../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCommand>()),
  resolveCodexCommand: () => mocks.codexPath
}))
vi.mock('../codex/codex-hook-trust-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustDerivation>()),
  probeCodexVersion: mocks.probeCodexVersion,
  deriveCodexHookHashes: mocks.deriveCodexHookHashes
}))

const hooksPath = (): string => join(getSystemCodexHomePath(), 'hooks.json')
const tomlPath = (): string => join(getSystemCodexHomePath(), 'config.toml')

const HOOK_PROBLEMS: readonly [string, () => void][] = [
  [
    'Codex is too old to approve hooks',
    () => {
      const failure = 'Codex 0.120.0 is too old for Orca status; update Codex'
      mocks.deriveCodexHookHashes.mockResolvedValue({
        kind: 'refused',
        codexVersion: 'codex-cli 0.120.0',
        failure
      } satisfies CodexHookAnswer)
    }
  ],
  ['Codex is not installed', () => (mocks.codexPath = join(testState.fakeHomeDir, 'no-codex'))],
  ['~/.codex/hooks.json does not parse', () => writeFileSync(hooksPath(), '{ not json')],
  [
    '~/.codex/hooks.json has a root key Codex skips',
    () => writeFileSync(hooksPath(), JSON.stringify({ hooks: {}, _managed: true }))
  ],
  [
    '~/.codex/config.toml keeps hook approvals inline',
    () => writeFileSync(tomlPath(), 'model = "m"\nhooks = { state = {} }\n')
  ]
]

beforeEach(() => {
  mocks.blockedHookFile = ''
  setupRuntimeHomeTest()
  installFakeAppEnvironment({ getPath: () => testState.userDataDir })
  mocks.codexPath = join(testState.userDataDir, 'codex')
  writeFileSync(mocks.codexPath, 'codex')
  mocks.probeCodexVersion.mockResolvedValue('codex-cli 0.160.1')
  mocks.deriveCodexHookHashes.mockResolvedValue({
    kind: 'hashes',
    codexVersion: 'codex-cli 0.160.1',
    hashes: { stop: 'sha256:codex-stop' }
  } satisfies CodexHookAnswer)
})

afterEach(() => {
  vi.restoreAllMocks()
  teardownRuntimeHomeTest()
})

describe('a status-hook problem never moves the system default off ~/.codex', () => {
  it.each(HOOK_PROBLEMS)('when %s', async (_case, arrange) => {
    arrange()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = new Map(
      [hooksPath(), tomlPath()].map((path) => [path, readOptional(path)] as const)
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const { startCodexHooks, _internals } = await import('../codex/codex-hook-reconcile')
    const { readCurrentCodexHookStatus } = await import('../codex/codex-hook-status')
    const store = createStore(createSettings({ realHomeRoutable: true }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only getSettings/updateSettings, which the harness store implements.
    const service = new CodexRuntimeHomeService(store as never)

    startCodexHooks({
      pathReady: Promise.resolve(),
      isEnabled: () => true,
      resolveLaunchHome: () => service.resolveHostCodexHomePathForLaunchReadOnly()
    })
    await _internals.settledForTesting()

    expect(service.isHostSystemDefaultRealHomeSelected()).toBe(true)

    expect(service.resolveHostCodexHomePathForLaunchReadOnly()).toBeNull()
    await expect(service.prepareForCodexLaunchAsync()).resolves.toBeNull()
    const status = readCurrentCodexHookStatus()
    expect(status.configPath).toBe(hooksPath())
    expect(status.detail).toBeTruthy()
    if (before.get(hooksPath()) !== null) {
      expect(readOptional(hooksPath())).toBe(before.get(hooksPath()))
    }
  })
})

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

it('startup family maintenance retries an actual failed hook write; ordinary launch scheduling does not rescan actors', async () => {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  const { startCodexHooks, scheduleCodexHookReconcile, _internals } =
    await import('../codex/codex-hook-reconcile')
  const { createCodexAuthJson } = await import('./runtime-home-service-test-harness')
  writeFileSync(
    join(getSystemCodexHomePath(), 'auth.json'),
    createCodexAuthJson('fixture@example.com', 'system', 'fixture')
  )
  writeFileSync(tomlPath(), 'model = "fixture"\n')
  const store = createStore(
    createSettings({
      realHomeRoutable: true,
      codexSessionSourceHome: { host: join(testState.userDataDir, 'X') }
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: real service reads only the harness settings store ports.
  const service = new CodexRuntimeHomeService(store as never)
  const O = service.prepareForCodexLaunch()!
  mocks.blockedHookFile = join(O, 'hooks.json')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  try {
    startCodexHooks({
      pathReady: Promise.resolve(),
      isEnabled: () => true,
      resolveLaunchHome: () => null,
      reconcileRetainedHomes: () => service.reconcileRetainedHostCodexHooks()
    })
    await _internals.settledForTesting()
    expect(fs.existsSync(join(O, 'hooks.json'))).toBe(false)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    mocks.blockedHookFile = ''
    await vi.advanceTimersByTimeAsync(100)
    await _internals.settledForTesting()
    expect(readFileSync(join(O, 'hooks.json'), 'utf8')).toContain('orca')
    const before = mocks.readdirCalls
    scheduleCodexHookReconcile()
    await _internals.settledForTesting()
    expect(mocks.readdirCalls).toBe(before)
    const source = readFileSync(join(getSystemCodexHomePath(), 'auth.json'), 'utf8')
    await service.reconcileRetainedHostCodexHooks()
    expect(readFileSync(join(getSystemCodexHomePath(), 'auth.json'), 'utf8')).toBe(source)
  } finally {
    _internals.resetForTesting()
    vi.useRealTimers()
  }
})

it('real outer family reconciliation at N/10N keeps root enumeration constant and serialized metadata/bytes linear', async () => {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  const { resolveCodexLaunchHome } = await import('../codex/codex-launch-home')
  const { createCodexAuthJson } = await import('./runtime-home-service-test-harness')
  const { _internals } = await import('../codex/codex-hook-reconcile')
  _internals.resetForTesting()
  const store = createStore(createSettings({ realHomeRoutable: true }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: real service reads only the harness settings store ports.
  const service = new CodexRuntimeHomeService(store as never)
  writeFileSync(
    join(getSystemCodexHomePath(), 'auth.json'),
    createCodexAuthJson('fixture@example.com', 'system', 'fixture')
  )
  writeFileSync(tomlPath(), 'model = "fixture"\n')
  const system = getSystemCodexHomePath(),
    source = join(testState.userDataDir, 'X')
  const actors: string[] = []
  const counts: { roots: number; metadata: number; bytes: number }[] = []
  for (const count of [8, 80]) {
    while (actors.length < count) {
      actors.push(
        resolveCodexLaunchHome({
          selectedAccount: null,
          systemHome: system,
          accountsRoot: join(testState.userDataDir, 'codex-accounts'),
          storeHome: source
        })!
      )
    }
    mocks.readdirCalls = 0
    mocks.metadataCalls = 0
    mocks.writtenBytes = 0
    expect(await service.reconcileRetainedHostCodexHooks()).toBe(true)
    counts.push({
      roots: mocks.readdirCalls,
      metadata: mocks.metadataCalls,
      bytes: mocks.writtenBytes
    })
    for (const actor of actors) {
      expect(readFileSync(join(actor, 'hooks.json'), 'utf8')).toContain('orca')
    }
  }
  expect(counts[1].roots).toBe(counts[0].roots)
  expect(counts[1].metadata).toBeLessThanOrEqual(counts[0].metadata * 10)
  expect(counts[1].bytes).toBeLessThanOrEqual(counts[0].bytes * 10)
  console.warn('retained-family-production-N10N', JSON.stringify({ actors: [8, 80], counts }))
})

it('shutdown retires queued family maintenance before the actual writer enters', async () => {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  const { runExclusivelyForCodexTrustConfig } =
    await import('../codex/codex-trust-config-mutation-queue')
  const { startCodexHooks, stopCodexHooks, _internals } =
    await import('../codex/codex-hook-reconcile')
  const store = createStore(createSettings({ realHomeRoutable: true }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only the harness store ports.
  const service = new CodexRuntimeHomeService(store as never)
  const before = readOptional(hooksPath())
  let release!: () => void
  const blocker = runExclusivelyForCodexTrustConfig(
    tomlPath(),
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const entered = vi.fn()
  startCodexHooks({
    pathReady: Promise.resolve(),
    isEnabled: () => true,
    resolveLaunchHome: () => join(testState.userDataDir, 'not-selected'),
    reconcileRetainedHomes: (isCurrent) => {
      entered()
      return service.reconcileRetainedHostCodexHooks([], isCurrent)
    }
  })
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  stopCodexHooks()
  release()
  await blocker
  await _internals.settledForTesting()
  expect(readOptional(hooksPath())).toBe(before)
  _internals.resetForTesting()
})
