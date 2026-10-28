import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnNativeDaemonPty } from './native-pty-spawn'
import { TerminalCreationWork } from '../terminal-creation-work'
import {
  _resetConptyStartupTrustForTest,
  CONPTY_NO_INPUT_READER_NOTICE,
  CONPTY_STARTUP_DECISION_LIMIT_MS
} from './conpty-startup-input-reader'

const nodePty = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => nodePty)
const ptyJob = vi.hoisted(() => ({
  assignHostProcessToKillOnCloseJob: vi.fn(),
  terminatePtyJob: vi.fn(),
  killConptyNow: vi.fn()
}))
vi.mock('../../windows/windows-pty-job', () => ptyJob)

const attempts = ['pwsh.exe', 'powershell.exe', 'cmd.exe'].map((shellPath) => ({
  shellPath,
  shellArgs: [shellPath === 'cmd.exe' ? '/K' : '-NoExit'],
  effectiveCwd: 'C:\\work',
  validationCwd: 'C:\\work',
  startupCommandDeliveredInShellArgs: true
}))
const args = {
  primaryArgsRespawnSafe: true,
  shellPath: attempts[0]!.shellPath,
  shellArgs: attempts[0]!.shellArgs,
  spawnCwd: 'C:\\work',
  env: {},
  cols: 80,
  rows: 24,
  windowsFallbackAttempts: attempts
}

const CONPTY_PRELUDE = '\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h'

/** A pane that writes `chunks` on later ticks, as ConPTY's output socket does. */
function fakePane(pid: number, chunks: string[], exitCode?: number) {
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number }) => void>()
  const pane = {
    pid,
    kill: vi.fn(),
    resume: vi.fn(),
    write: vi.fn(),
    exit: (code: number) => {
      for (const listener of exitListeners) {
        listener({ exitCode: code })
      }
    },
    onData: (listener: (data: string) => void) => {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListeners.add(listener)
      return { dispose: () => exitListeners.delete(listener) }
    }
  }
  void (async () => {
    for (const chunk of chunks) {
      await new Promise((resolve) => setImmediate(resolve))
      for (const listener of dataListeners) {
        listener(chunk)
      }
    }
    if (exitCode !== undefined) {
      await new Promise((resolve) => setImmediate(resolve))
      for (const listener of exitListeners) {
        listener({ exitCode })
      }
    }
  })()
  return pane
}

const healthyPane = (pid: number) => fakePane(pid, [CONPTY_PRELUDE])
const deadPane = (pid: number) => fakePane(pid, ['Microsoft Windows\r\n'])

describe('Windows shell fallback over node-pty ConPTY', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    nodePty.spawn.mockReset()
    ptyJob.terminatePtyJob.mockReset()
    _resetConptyStartupTrustForTest()
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    vi.restoreAllMocks()
  })

  it('checks operation authority after loading the native module, before physical spawn', async () => {
    let allowed = true
    const creationWork = new TerminalCreationWork()
    const starting = spawnNativeDaemonPty({
      ...args,
      creationWork,
      assertCreateAllowed: () => {
        if (!allowed) {
          throw new Error('expired')
        }
      }
    })
    allowed = false
    await expect(starting).rejects.toThrow('expired')
    expect(nodePty.spawn).not.toHaveBeenCalled()
    await creationWork.finish()
    expect(await creationWork.completion).toEqual({ kind: 'no-fork' })
  })

  it('does not dispatch a fallback shell after the operation loses authority', async () => {
    let allowed = true
    nodePty.spawn.mockImplementation(() => {
      allowed = false
      throw new Error('primary refused')
    })
    await expect(
      spawnNativeDaemonPty({
        ...args,
        assertCreateAllowed: () => {
          if (!allowed) {
            throw new Error('expired')
          }
        }
      })
    ).rejects.toThrow('primary refused')
    expect(nodePty.spawn).toHaveBeenCalledOnce()
  })

  it('settles exact no-export native failure without trying another switch shell', async () => {
    const creationWork = new TerminalCreationWork()
    nodePty.spawn.mockImplementation(() => {
      throw new Error('opaque native dispatch failure')
    })
    await expect(
      spawnNativeDaemonPty({ ...args, creationWork, retainCanceledChild: true })
    ).rejects.toThrow('opaque native dispatch failure')
    await creationWork.finish()
    expect(await creationWork.completion).toMatchObject({ kind: 'failed' })
    expect(nodePty.spawn).toHaveBeenCalledOnce()
  })

  it.each(['physical', 'exited', 'unknown'] as const)(
    'keeps every %s predecessor when a later native invocation fails',
    async (predecessor) => {
      const creationWork = new TerminalCreationWork()
      const pane = healthyPane(999_999_999)
      if (predecessor === 'unknown') {
        pane.onExit = () => {
          throw new Error('external listener failure')
        }
      }
      nodePty.spawn.mockReturnValueOnce(pane)
      await (predecessor !== 'unknown'
        ? spawnNativeDaemonPty({ ...args, creationWork })
        : expect(
            spawnNativeDaemonPty({ ...args, windowsFallbackAttempts: [attempts[0]!], creationWork })
          ).rejects.toThrow('external listener failure'))
      if (predecessor === 'exited') {
        pane.exit(0)
      }
      nodePty.spawn.mockImplementation(() => {
        throw new Error('later no-export failure')
      })
      await expect(
        spawnNativeDaemonPty({ ...args, creationWork, retainCanceledChild: true })
      ).rejects.toThrow('later no-export failure')
      await creationWork.finish()
      const disposition = await creationWork.completion
      if (predecessor === 'unknown') {
        expect(disposition.kind).toBe('unknown')
        return
      }
      if (disposition.kind !== 'failed') {
        throw new Error('failed aggregate was collapsed')
      }
      let completed = false
      void disposition.completion.then(() => {
        completed = true
      })
      await Promise.resolve()
      if (predecessor === 'physical') {
        expect(completed).toBe(false)
      }
      expect(disposition.recover).toBeTypeOf('function')
      pane.exit(0)
      await disposition.completion
      expect((await creationWork.completion).kind).toBe('failed')
    }
  )

  it('keeps a WSL pane out of a distro the internal allowlist excludes, falling back past it', async () => {
    vi.stubEnv('ORCA_INTERNAL_WSL_DISTRO_ALLOWLIST', 'orca-test-a')
    try {
      const wslAttempts = ['Ubuntu', 'orca-test-a'].map((distro) => ({
        ...attempts[0]!,
        shellPath: 'C:\\Windows\\System32\\wsl.exe',
        shellArgs: ['-d', distro, '--cd', '~']
      }))
      nodePty.spawn.mockReturnValue(healthyPane(4242))
      const result = await spawnNativeDaemonPty({
        ...args,
        shellPath: wslAttempts[0]!.shellPath,
        shellArgs: wslAttempts[0]!.shellArgs,
        windowsFallbackAttempts: wslAttempts
      })
      expect(nodePty.spawn.mock.calls.map(([, argv]) => argv)).toEqual([
        ['-d', 'orca-test-a', '--cd', '~']
      ])
      expect(result.shellPath).toBe(wslAttempts[1]!.shellPath)

      nodePty.spawn.mockClear()
      await expect(
        spawnNativeDaemonPty({
          ...args,
          shellPath: wslAttempts[0]!.shellPath,
          shellArgs: wslAttempts[0]!.shellArgs,
          windowsFallbackAttempts: [wslAttempts[0]!]
        })
      ).rejects.toMatchObject({ code: 'ORCA_WSL_DISTRO_NOT_ALLOWLISTED' })
      expect(nodePty.spawn).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('walks both fallback shells when ConPTY rejects the primary ones', async () => {
    const proc = fakePane(9876, [CONPTY_PRELUDE])
    nodePty.spawn.mockImplementation((file: string) => {
      if (file !== 'cmd.exe') {
        throw new Error(`spawn ${file} EACCES`)
      }
      return proc
    })
    const creationWork = new TerminalCreationWork()
    const result = await spawnNativeDaemonPty({ ...args, creationWork })
    await creationWork.finish()
    // Ordinary fallback keeps the actual returned owner and earlier failed physical-unknown fact.
    expect(await creationWork.completion).toMatchObject({ kind: 'failed' })
    proc.exit(0)
    expect(nodePty.spawn.mock.calls.map(([file]) => file)).toEqual([
      'pwsh.exe',
      'powershell.exe',
      'cmd.exe'
    ])
    expect(nodePty.spawn.mock.calls[2]![2]).toMatchObject({ useConptyDll: true })
    expect(result.process).toBe(proc)
    expect(result.shellPath).toBe('cmd.exe')
    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
  })

  it('respawns a pane whose ConPTY never started reading input', async () => {
    // Measured on CI: such a pane prints its banner and prompt, then ignores every keystroke.
    const broken = fakePane(990001, ['Microsoft Windows [Version 10.0.20348]\r\n'])
    const healthy = fakePane(990002, ['\x1b[1t', '\x1b[c\x1b[?1004h', 'Microsoft Windows'])
    broken.kill.mockImplementation(() => broken.exit(137))
    nodePty.spawn.mockReturnValueOnce(broken).mockReturnValueOnce(healthy)
    const creationWork = new TerminalCreationWork()
    const result = await spawnNativeDaemonPty({ ...args, creationWork, retainCanceledChild: true })
    await creationWork.finish()
    const disposition = await creationWork.completion
    if (disposition.kind !== 'physical') {
      throw new Error('native attempts lost their owners')
    }
    let completed = false
    void disposition.completion.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    healthy.exit(0)
    await disposition.completion

    expect(nodePty.spawn.mock.calls.map(([file]) => file)).toEqual(['pwsh.exe', 'pwsh.exe'])
    expect(ptyJob.terminatePtyJob).toHaveBeenCalledWith(broken)
    expect(broken.kill).toHaveBeenCalledOnce()
    expect(broken.write).not.toHaveBeenCalled()
    expect(result.process).toBe(healthy)
    expect(result.shellPath).toBe('pwsh.exe')
    expect(healthy.write).toHaveBeenCalledExactlyOnceWith('\x1b[?61;4c')
    expect(result.claimStartupEvents?.().data).toEqual(['\x1b[1t\x1b[?1004h'])
  })

  it('keeps failed after a retained ConPTY predecessor really exits before the native retry throws', async () => {
    const creationWork = new TerminalCreationWork()
    const broken = deadPane(999_999_999)
    broken.kill.mockImplementation(() => broken.exit(137))
    nodePty.spawn.mockReturnValueOnce(broken).mockImplementationOnce(() => {
      throw new Error('retry exported no handle')
    })
    await expect(
      spawnNativeDaemonPty({ ...args, creationWork, retainCanceledChild: true })
    ).rejects.toThrow('retry exported no handle')
    await creationWork.finish()
    const disposition = await creationWork.completion
    if (disposition.kind !== 'failed') {
      throw new Error('failed retry was collapsed into exit')
    }
    await disposition.completion
    expect(nodePty.spawn.mock.calls.map(([file]) => file)).toEqual(['pwsh.exe', 'pwsh.exe'])
    expect(broken.kill).toHaveBeenCalledOnce()
    expect(broken.write).not.toHaveBeenCalled()
  })

  it('respawns only once, then says so in the pane', async () => {
    nodePty.spawn.mockReturnValueOnce(healthyPane(990001))
    await spawnNativeDaemonPty(args)
    const first = deadPane(990002)
    const second = deadPane(990003)
    nodePty.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)

    const result = await spawnNativeDaemonPty(args)

    expect(nodePty.spawn).toHaveBeenCalledTimes(3)
    expect(second.kill).not.toHaveBeenCalled()
    expect(result.process).toBe(second)
    expect(result.claimStartupEvents?.().data).toEqual([
      'Microsoft Windows\r\n',
      CONPTY_NO_INPUT_READER_NOTICE
    ])
  })

  it('never respawns a shell whose argv may carry a command', async () => {
    nodePty.spawn.mockReturnValueOnce(healthyPane(990001))
    await spawnNativeDaemonPty(args)
    const dead = deadPane(990002)
    nodePty.spawn.mockReturnValueOnce(dead)

    const result = await spawnNativeDaemonPty({ ...args, primaryArgsRespawnSafe: false })

    expect(nodePty.spawn).toHaveBeenCalledTimes(2)
    expect(dead.kill).not.toHaveBeenCalled()
    expect(result.claimStartupEvents?.().data.at(-1)).toBe(CONPTY_NO_INPUT_READER_NOTICE)
  })

  it('stops checking when no pane ever announces, as a changed ConPTY build would', async () => {
    nodePty.spawn.mockReturnValueOnce(deadPane(990001)).mockReturnValueOnce(deadPane(990002))
    const result = await spawnNativeDaemonPty(args)
    expect(result.claimStartupEvents?.().data).not.toContain(CONPTY_NO_INPUT_READER_NOTICE)

    const later = deadPane(990003)
    nodePty.spawn.mockReturnValueOnce(later)
    expect((await spawnNativeDaemonPty(args)).process).toBe(later)
    expect(nodePty.spawn).toHaveBeenCalledTimes(3)
  })

  it('does not respawn a shell that exited before ConPTY announced anything', async () => {
    const exited = fakePane(990001, [], 3)
    nodePty.spawn.mockReturnValueOnce(exited)

    const result = await spawnNativeDaemonPty(args)

    expect(nodePty.spawn).toHaveBeenCalledOnce()
    expect(result.claimStartupEvents?.().exit).toEqual({ exitCode: 3 })
  })

  it('kills the pane tree when the spawn is canceled while startup is awaited', async () => {
    const controller = new AbortController()
    const silent = fakePane(990001, [])
    nodePty.spawn.mockReturnValueOnce(silent)
    const spawned = spawnNativeDaemonPty({ ...args, signal: controller.signal })
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort(new Error('spawn canceled'))

    await expect(spawned).rejects.toThrow('spawn canceled')
    expect(ptyJob.terminatePtyJob).toHaveBeenCalledWith(silent)
    // node-pty defers kill() until first output, which a silent pane never produces.
    expect(ptyJob.killConptyNow).toHaveBeenCalledWith(silent)
    expect(silent.kill).toHaveBeenCalledOnce()
    expect(nodePty.spawn).toHaveBeenCalledOnce()
  })

  it('hands out a pane that stays silent instead of stalling the spawn', async () => {
    vi.useFakeTimers()
    const silent = fakePane(990001, [])
    nodePty.spawn.mockReturnValueOnce(silent)
    const spawned = spawnNativeDaemonPty(args)
    await vi.advanceTimersByTimeAsync(CONPTY_STARTUP_DECISION_LIMIT_MS)
    const result = await spawned
    vi.useRealTimers()

    expect(nodePty.spawn).toHaveBeenCalledOnce()
    expect(silent.kill).not.toHaveBeenCalled()
    expect(result.process).toBe(silent)
  })

  it('starts no fallback shell once the spawn is canceled', async () => {
    const controller = new AbortController()
    nodePty.spawn.mockImplementation(() => {
      controller.abort(new Error('spawn canceled'))
      throw new Error('spawn pwsh.exe EACCES')
    })
    await expect(spawnNativeDaemonPty({ ...args, signal: controller.signal })).rejects.toThrow(
      'spawn canceled'
    )
    expect(nodePty.spawn).toHaveBeenCalledOnce()
  })
})
