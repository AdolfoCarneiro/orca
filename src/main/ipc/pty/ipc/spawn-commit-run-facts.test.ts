import type * as NodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _internals,
  getObservedCodexPaneHome,
  getCodexPaneAccount,
  dismissCodexPaneAccount,
  hasRecordedLegacySharedCodexPane,
  captureCodexPaneAccountInventory,
  reconcileCodexPaneAccountsWithLivePtys,
  forgetCodexPaneAccount
} from '../../../codex/codex-pane-account-registry'
import { installPtyCodexSharedServerIpcHandler } from './codex-shared-server'
import { setLocalPtyProvider } from '../provider/registry'

const external = vi.hoisted(() => ({
  registryWriteFailure: false,
  handlers: new Map<string, (_event: unknown, args: { id: string }) => Promise<unknown>>(),
  run: vi.fn(),
  probe: vi.fn(),
  processes: vi.fn()
}))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof NodeFs>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (external.registryWriteFailure && to.endsWith('codex-pane-accounts.json')) {
        throw Object.assign(new Error('fixture locked registry'), { code: 'EACCES' })
      }
      return actual.renameSync(from, to)
    }
  }
})
vi.mock('../pty-host-bindings', () => ({
  getPtyIpc: () => ({
    handle: (channel: string, handler: never) => external.handlers.set(channel, handler)
  })
}))
vi.mock('@orca/process-host', async (original) => ({
  ...(await original<object>()),
  runProcess: external.run
}))
vi.mock('../../../../shared/process-table-snapshot-reader', async (original) => ({
  ...(await original<object>()),
  getProcessTableSnapshot: external.processes
}))
vi.mock('../../../windows/windows-process-table', () => ({
  readWindowsProcessTable: external.processes
}))
vi.mock('../../../codex/codex-shared-server-probe', () => ({
  probeCodexSharedServer: external.probe
}))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithRuntimeId } from '../../../runtime/construction/runtime-identity-state'
import { TerminalIntentionalStops } from '../../../runtime/terminal-intentional-stops'
import { TerminalRunFactsRegister } from '../../../runtime/terminal-run-facts'
import { ptySizes } from '../delivery/visibility-state'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { commitPtyIpcSpawn } from './spawn-commit'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcDeps } from './spawn-types'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const PTY_ID = 'orca-ipc-pty-run-facts'
const INCARNATION_ID = 'inc-ipc-run-facts'

async function commit(
  persistPtyBinding: ReturnType<typeof vi.fn>,
  prepare?: (ctx: ReturnType<typeof createPtyIpcSpawnState>) => void
) {
  const facts = new TerminalRunFactsRegister()
  const stops = new TerminalIntentionalStops()
  stops.mark(PTY_ID, 'reversible', null)(true)
  const runtime = {
    terminalRunFacts: facts,
    intentionalPtyStops: stops,
    // Exercise real runtime commit handling through the fixture ports.
    noteTerminalSpawnCommit: OrcaRuntimeWithRuntimeId.prototype.noteTerminalSpawnCommit,
    registerPreAllocatedHandleForPty: vi.fn(),
    registerPty: vi.fn(),
    cancelPendingPtyRegistration: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn(),
    seedHeadlessTerminal: vi.fn(),
    noteTerminalSpawnCommand: vi.fn()
  }
  const ports = {
    runtime,
    store: { persistPtyBinding },
    options: {},
    sendPtySpawnedToRenderer: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commit reads only the ports above, and the store only for its binding save.
  const deps = ports as unknown as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    cols: 120,
    rows: 40
  })
  ctx.validatedLeafId = 'leaf-1'
  ctx.provider = { ...ctx.provider, shutdown: vi.fn().mockResolvedValue(undefined) }
  ctx.result = { id: PTY_ID, incarnationId: INCARNATION_ID }
  prepare?.(ctx)
  let reply: Awaited<ReturnType<typeof commitPtyIpcSpawn>> | undefined
  const outcome = await commitPtyIpcSpawn(ctx).then(
    (result) => {
      reply = result
      return 'committed'
    },
    () => 'discarded'
  )
  return { outcome, facts, stops, reply }
}

describe('renderer spawn commit: run facts', () => {
  afterEach(() => {
    ptySizes.delete(PTY_ID)
    ptyOwnership.delete(PTY_ID)
    ptyIncarnationById.delete(PTY_ID)
  })

  it('records a committed spawn and lets it supersede a landed stop no exit pinned', async () => {
    const { outcome, facts, stops } = await commit(vi.fn().mockResolvedValue(true))

    expect(outcome).toBe('committed')
    expect(facts.read(PTY_ID, INCARNATION_ID).freshSpawn).toBe(true)
    expect(stops.claimExit(PTY_ID, INCARNATION_ID)).toEqual([])
  })

  it.each([false, true])(
    'keeps a refused shell disposition when early exit is %s',
    async (earlyExit) => {
      const refused = {
        agent: 'claude' as const,
        providerSession: { key: 'session_id' as const, id: 'chat-held' }
      }
      const { outcome, reply } = await commit(vi.fn().mockResolvedValue(true), (ctx) => {
        ctx.resumeAdmission = { verdict: 'chat-home', refused }
        if (earlyExit) {
          ctx.metadataLeafId = 'leaf-1'
          ctx.deps.runtime!.getPtyLivenessVerdict = vi.fn(() => ({ status: 'exited' as const }))
          ctx.deps.store!.runDurableMutation = vi.fn().mockResolvedValue(true)
          ctx.deps.runtime!.registerPty = vi.fn(() => {
            throw new Error('agent_session_exited_during_start')
          })
        }
      })
      expect(outcome).toBe('committed')
      expect(reply?.kind).toBe(earlyExit ? 'registration-exited' : 'committed')
      expect(reply?.result).toMatchObject({
        id: PTY_ID,
        incarnationId: INCARNATION_ID,
        agentResumeUnavailable: true,
        agentResumeRefused: 'chat-home',
        refusedResume: refused,
        savedResumeDecision: { ...refused, verdict: 'chat-home' }
      })
    }
  )

  it('records nothing for a spawn discarded because its binding save failed', async () => {
    const persistPtyBinding = vi.fn().mockRejectedValue(new Error('disk full'))
    const { outcome, facts, stops } = await commit(persistPtyBinding)

    expect(outcome).toBe('discarded')
    expect(persistPtyBinding).toHaveBeenCalledOnce()
    expect(facts.read(PTY_ID, INCARNATION_ID).freshSpawn).toBe(false)
    expect(stops.claimExit(PTY_ID, INCARNATION_ID)).toEqual(['replaced'])
  })
})

it('publishes frozen actual O before callbacks; disk restart qualifies only the provider birth and dismissal keeps the address', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-modern-receipt-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  _internals.resetProcess()
  const actualHome = join(root, 'actual-O')
  const binary = join(
    actualHome,
    'packages',
    'standalone',
    'current',
    'bin',
    process.platform === 'win32' ? 'codex.exe' : 'codex'
  )
  mkdirSync(join(actualHome, 'packages', 'standalone', 'current', 'bin'), { recursive: true })
  writeFileSync(binary, 'fixture executable; never executed')
  let session = { id: PTY_ID, incarnationId: INCARNATION_ID, rootProcessId: 100 }
  external.processes.mockResolvedValue([
    { pid: 100, ppid: 1, stat: 'S', command: '-zsh' },
    { pid: 101, ppid: 100, stat: 'S', command: 'codex' }
  ])
  external.probe.mockResolvedValue('live')
  external.run.mockResolvedValue({
    code: 0,
    timedOut: false,
    stdout: 'daemon_auto_start experimental false\n'
  })
  const note = vi.fn(() => expect(getObservedCodexPaneHome(PTY_ID)?.actualHome).toBe(actualHome))
  try {
    await commit(vi.fn().mockResolvedValue(true), (ctx) => {
      ctx.isDaemonHostSpawn = true
      ctx.selectedCodexHomePath = actualHome
      ctx.preparedCodexHome = {
        home: actualHome,
        loginHome: join(root, 'system-H'),
        store: join(root, 'X'),
        family: root,
        disposition: 'layered',
        selectionKey: 'host',
        accountId: null
      }
      ctx.deps.getSettings = () => ({ activeCodexManagedAccountId: 'later-B' }) as never
      ctx.deps.runtime!.noteTerminalSpawnCommit = note
    })
    expect(note).toHaveBeenCalledOnce()
    const saved = JSON.parse(readFileSync(join(root, 'codex-pane-accounts.json'), 'utf8'))
    expect(saved.panes[PTY_ID]).toEqual({
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home',
      launchProvenance: { homePath: actualHome, incarnationId: INCARNATION_ID }
    })
    const observation = getObservedCodexPaneHome(PTY_ID)
    _internals.resetCache()
    expect(getObservedCodexPaneHome(PTY_ID)).toBe(observation)
    dismissCodexPaneAccount(PTY_ID)
    expect(getCodexPaneAccount(PTY_ID)).toBeNull()
    expect(hasRecordedLegacySharedCodexPane()).toBe(false)
    _internals.resetProcess()
    const provider = {
      listProcesses: async () => [session],
      spawn: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onData: () => () => {},
      onExit: () => () => {},
      getForegroundProcess: async () => null
    }
    setLocalPtyProvider(provider)
    installPtyCodexSharedServerIpcHandler({ getLocalPtyProviderStartupPromise: () => undefined })
    const invoke = (channel: string) => external.handlers.get(channel)!({}, { id: PTY_ID })
    expect(await invoke('pty:isCodexOnSharedServer')).toMatchObject({ joined: true })
    expect(external.probe).toHaveBeenLastCalledWith(actualHome)
    expect(await invoke('pty:disableCodexSharedServerAutoStart')).toBe(true)
    expect(external.run.mock.calls[0][0]).toMatchObject({
      program: binary,
      env: { CODEX_HOME: actualHome }
    })
    expect(getCodexPaneAccount(PTY_ID)).toBeNull()
    external.probe.mockResolvedValue('absent')
    expect(await invoke('pty:stopCodexSharedServer')).toBe(true)
    _internals.resetProcess()
    session = { ...session, incarnationId: 'replacement-birth' }
    const before = external.run.mock.calls.length
    expect(await invoke('pty:stopCodexSharedServer')).toBe(false)
    expect(external.run).toHaveBeenCalledTimes(before)
    expect(getObservedCodexPaneHome(PTY_ID)).toBeNull()
  } finally {
    _internals.resetProcess()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})

it('a delayed authoritative census and action cannot erase or operate on a successor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-modern-fences-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  _internals.resetProcess()
  const prepare = (home: string) => (ctx: ReturnType<typeof createPtyIpcSpawnState>) => {
    ctx.isDaemonHostSpawn = true
    ctx.selectedCodexHomePath = home
    ctx.preparedCodexHome = {
      home,
      loginHome: home,
      store: home,
      family: root,
      disposition: 'direct',
      selectionKey: 'host',
      accountId: null
    }
  }
  try {
    await commit(vi.fn().mockResolvedValue(true), prepare(join(root, 'first')))
    const sampled = captureCodexPaneAccountInventory()
    const old = getObservedCodexPaneHome(PTY_ID)
    await commit(vi.fn().mockResolvedValue(true), prepare(join(root, 'next')))
    reconcileCodexPaneAccountsWithLivePtys([], sampled)
    expect(getObservedCodexPaneHome(PTY_ID)).not.toBe(old)
    expect(getObservedCodexPaneHome(PTY_ID)?.actualHome).toBe(join(root, 'next'))
    expect(getCodexPaneAccount(PTY_ID)?.launchProvenance?.homePath).toBe(join(root, 'next'))
  } finally {
    _internals.resetProcess()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})

it('qualifies known legacy H only during its runtime and fences a delayed process read before any effect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-known-home-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  _internals.resetProcess()
  const home = join(root, 'system-H')
  const prepare = (ctx: ReturnType<typeof createPtyIpcSpawnState>) => {
    ctx.isDaemonHostSpawn = true
    ctx.result = { id: PTY_ID }
    ctx.selectedCodexHomePath = null
    ctx.preparedCodexHome = {
      home: null,
      loginHome: home,
      store: home,
      family: root,
      disposition: 'direct',
      selectionKey: 'host',
      accountId: null
    }
    ctx.deps.getSettings = () =>
      ({ codexManagedAccounts: [], activeCodexManagedAccountId: null }) as never
  }
  try {
    await commit(vi.fn().mockResolvedValue(true), prepare)
    const original = getObservedCodexPaneHome(PTY_ID)
    expect(original?.actualHome).toBe(home)
    await commit(vi.fn().mockResolvedValue(true), (ctx) => {
      prepare(ctx)
      ctx.result.isReattach = true
      ctx.selectedCodexHomePath = join(root, 'requested-other-O')
    })
    expect(getObservedCodexPaneHome(PTY_ID)).toBe(original)
    let release!: (rows: { pid: number; ppid: number; stat: string; command: string }[]) => void
    external.processes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const provider = {
      listProcesses: async () => [{ id: PTY_ID, rootProcessId: 100 }],
      spawn: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onData: () => () => {},
      onExit: () => () => {},
      getForegroundProcess: async () => null
    }
    setLocalPtyProvider(provider)
    ptyIncarnationById.delete(PTY_ID)
    installPtyCodexSharedServerIpcHandler({ getLocalPtyProviderStartupPromise: () => undefined })
    const pending = external.handlers.get('pty:isCodexOnSharedServer')!({}, { id: PTY_ID })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    forgetCodexPaneAccount(PTY_ID)
    const probes = external.probe.mock.calls.length
    release([
      { pid: 100, ppid: 1, stat: 'S', command: 'zsh' },
      { pid: 101, ppid: 100, stat: 'S', command: 'codex' }
    ])
    expect(await pending).toEqual({ joined: false })
    expect(external.probe).toHaveBeenCalledTimes(probes)
    await commit(vi.fn().mockResolvedValue(true), prepare)
    _internals.resetProcess()
    expect(await external.handlers.get('pty:isCodexOnSharedServer')!({}, { id: PTY_ID })).toEqual({
      joined: false
    })
    expect(getObservedCodexPaneHome(PTY_ID)).toBeNull()
  } finally {
    _internals.resetProcess()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})

it('real failed receipt rename preserves the latest live birth through cache resets and quiet retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-receipt-io-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  _internals.resetProcess()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const prepare = (home: string) => (ctx: ReturnType<typeof createPtyIpcSpawnState>) => {
    ctx.isDaemonHostSpawn = true
    ctx.selectedCodexHomePath = home
    ctx.preparedCodexHome = {
      home,
      loginHome: home,
      store: home,
      family: root,
      disposition: 'direct',
      selectionKey: 'host',
      accountId: null
    }
  }
  try {
    external.registryWriteFailure = true
    expect(
      (await commit(vi.fn().mockResolvedValue(true), prepare(join(root, 'first-O')))).outcome
    ).toBe('committed')
    await vi.advanceTimersByTimeAsync(120000)
    expect(vi.getTimerCount()).toBe(1)
    await commit(vi.fn().mockResolvedValue(true), prepare(join(root, 'latest-O')))
    _internals.resetCache()
    expect(getObservedCodexPaneHome(PTY_ID)?.actualHome).toBe(join(root, 'latest-O'))
    expect(existsSync(join(root, 'codex-pane-accounts.json'))).toBe(false)
    external.registryWriteFailure = false
    await vi.advanceTimersByTimeAsync(30000)
    const row = JSON.parse(readFileSync(join(root, 'codex-pane-accounts.json'), 'utf8')).panes[
      PTY_ID
    ]
    expect(row.launchProvenance).toEqual({
      homePath: join(root, 'latest-O'),
      incarnationId: INCARNATION_ID
    })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    external.registryWriteFailure = false
    _internals.resetProcess()
    vi.useRealTimers()
    warning.mockRestore()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})
