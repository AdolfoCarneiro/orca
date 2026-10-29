import { expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
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
  failure,
  applyAgentStatusHooksEnabled,
  main,
  slot
} from './claude-system-statusline.test-fixture'
it('distinguishes unknown legacy C=E from modern deletion and preserves user and profile slots', async () => {
  const marker = join(seam.home, '.orca/agent-hooks/claude-statusline.installed')
  await fs.mkdir(dirname(marker), { recursive: true })
  await fs.writeFile(marker, '')
  await write(file('.claude'), {})
  expect((await install('fresh-legacy')).state).toBe('installed')
  expect((await read(file('fresh-legacy'))).statusLine).toBeDefined()
  const legacyManaged = await read(file('fresh-legacy'))
  await remove('fresh-legacy')
  await fs.writeFile(marker, '')
  expect((await install('.claude')).state).toBe('installed')
  expect(slot(await read(file('.claude')))).toBe('managed')
  await remove('.claude')
  await fs.writeFile(marker, '')
  await write(file('.claude'), legacyManaged)
  const conventional = await fs.readFile(file('.claude'), 'utf8')
  expect((await install('legacy-migration')).state).toBe('installed')
  expect(await fs.readFile(file('.claude'), 'utf8')).toBe(conventional)
  expect(
    (await document()).destinations.some(
      (entry: { path: string }) => entry.path === file('.claude')
    )
  ).toBe(true)
  await erase('.claude')
  expect((await install('X')).state).toBe('installed')
  expect((await read(file('X'))).statusLine).toBeUndefined()
  await write(file('U'), { statusLine: { command: '/user/custom', type: 'command' } })
  expect((await install('U')).state).toBe('installed')
  expect((await read(file('U'))).statusLine.command).toBe('/user/custom')
  const before = await document()
  expect(
    service().installProfile({
      ...current,
      target: { kind: 'profile', configDir: dirname(file('profile')) }
    }).state
  ).toBe('installed')
  expect(await document()).toEqual(before)
  expect((await read(file('profile'))).statusLine).toBeUndefined()
  expect(await fs.readFile(marker, 'utf8')).toBe('')
})

it('retains independent owners and copied managed adoption, with reset and legitimate re-enable', async () => {
  expect((await install('X')).state).toBe('installed')
  const managed = await read(file('X'))
  await write(file('Y'), managed)
  expect((await install('Y')).state).toBe('installed')
  await erase('X')
  expect((await install('Z')).state).toBe('installed')
  expect((await read(file('Z'))).statusLine).toBeUndefined()
  expect((await install('Y')).state).toBe('installed')
  expect((await read(file('Y'))).statusLine).toBeDefined()
  expect((await install('X')).state).toBe('installed')
  expect((await read(file('X'))).statusLine).toBeUndefined()
  expect((await remove('Z')).state).toBe('not_installed')
  expect((await document()).destinations).toEqual([])
  expect((await install('X')).state).toBe('installed')
  expect((await read(file('X'))).statusLine).toBeDefined()
})

it.skipIf(process.platform === 'win32')(
  'binds directory and file aliases to the physical parent, not replacement names or file inodes',
  async () => {
    await write(file('P'), {})
    await fs.symlink(dirname(file('P')), dirname(file('A')))
    expect((await install('A')).state).toBe('installed')
    const owner = (await document()).destinations[0]
    expect(owner.path).toBe(file('P'))
    await fs.unlink(dirname(file('A')))
    await fs.mkdir(dirname(file('B')))
    await fs.symlink(file('P'), file('B'))
    expect((await install('B')).state).toBe('installed')
    expect((await document()).destinations).toHaveLength(1)
    await fs.unlink(file('B'))
    expect((await install('fresh')).state).toBe('installed')
    expect((await read(file('fresh'))).statusLine).toBeDefined()
    await erase('P')
    expect((await install('denied')).state).toBe('installed')
    expect((await read(file('denied'))).statusLine).toBeUndefined()
    await fs.rename(dirname(file('P')), join(seam.home, 'old-parent'))
    await write(file('P'), {})
    expect((await install('new-parent')).state).toBe('installed')
    expect((await read(file('new-parent'))).statusLine).toBeDefined()
  }
)

it('reports failed acquisition, heals surviving M, and treats loss before acquisition as unknown', async () => {
  seam.before = async (method, path) => {
    if (method === 'rename' && dirname(path) === storage() && path.endsWith('.json')) {
      throw failure()
    }
  }
  expect((await install('X')).state).toBe('error')
  expect((await read(file('X'))).statusLine).toBeDefined()
  seam.before = null
  expect((await install('X')).state).toBe('installed')
  expect((await document()).destinations).toHaveLength(1)
  await remove('X')
  seam.before = async (method, path) => {
    if (method === 'rename' && dirname(path) === storage() && path.endsWith('.json')) {
      throw failure()
    }
  }
  expect((await install('Y')).state).toBe('error')
  await erase('Y')
  seam.before = null
  expect((await install('Z')).state).toBe('installed')
  expect((await read(file('Z'))).statusLine).toBeDefined()
})

it.skipIf(process.platform === 'win32')(
  'keeps native publisher modes, dangling refusal and failed rename/cleanup outcomes through the real service',
  async () => {
    await write(file('X'), {})
    await fs.chmod(file('X'), 0o640)
    const original = await fs.readFile(file('X'), 'utf8')
    seam.before = async (method, path) => {
      if (method === 'rename' && path === file('X')) {
        throw Object.assign(new Error('injected cross-mount publication'), { code: 'EXDEV' })
      }
    }
    expect((await install('X')).state).toBe('error')
    expect(await fs.readFile(file('X'), 'utf8')).toBe(original)
    let failedCleanup = false
    seam.before = async (method, path) => {
      if (
        method === 'rm' &&
        path.startsWith(`${file('X')}.`) &&
        path.endsWith('.tmp') &&
        !failedCleanup
      ) {
        failedCleanup = true
        throw failure()
      }
    }
    expect((await install('X')).state).toBe('error')
    expect((await read(file('X'))).hooks.SessionStart).toHaveLength(1)
    seam.before = null
    expect((await install('X')).state).toBe('installed')
    expect((await fs.stat(file('X'))).mode & 0o777).toBe(0o640)
    expect((await fs.stat(await documentPath())).mode & 0o777).toBe(0o600)
    expect((await fs.stat(storage())).mode & 0o777).toBe(0o700)
    await fs.mkdir(dirname(file('dangling')))
    await fs.symlink(file('absent'), file('dangling'))
    expect((await install('dangling')).state).toBe('error')
    expect((await fs.lstat(file('dangling'))).isSymbolicLink()).toBe(true)
    await expect(fs.stat(file('absent'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.readdir(dirname(file('X')))).filter((name) => name.endsWith('.tmp'))).toEqual(
      []
    )
  }
)

it('preserves malformed metadata, treats failed historical identity/reads as unknown, and retries current failures truthfully', async () => {
  await install('X')
  const meta = await documentPath()
  await fs.writeFile(meta, '{broken')
  await write(file('fresh'), {})
  expect((await install('fresh')).state).toBe('error')
  expect(await fs.readFile(meta, 'utf8')).toBe('{broken')
  expect((await read(file('fresh'))).hooks.SessionStart).toHaveLength(1)
  expect((await read(file('fresh'))).statusLine).toBeUndefined()
  expect((await remove('fresh')).state).toBe('not_installed')
  await install('X')
  await erase('X')
  for (const fault of ['stat', 'readFile']) {
    seam.before = async (method, path) => {
      if (method === fault && path === (fault === 'stat' ? dirname(file('X')) : file('X'))) {
        throw failure()
      }
    }
    expect((await install(`unknown-${fault}`)).state).toBe('installed')
    expect((await read(file(`unknown-${fault}`))).statusLine).toBeDefined()
  }
  seam.before = async (method, path) => {
    if (method === 'stat' && path === dirname(file('new-parent'))) {
      throw failure()
    }
  }
  expect((await install('new-parent')).state).toBe('error')
  expect(
    (await document()).destinations.some(
      (entry: { path: string }) => entry.path === file('new-parent')
    )
  ).toBe(false)
  seam.before = null
  expect((await install('normal')).state).toBe('installed')
  expect((await read(file('normal'))).statusLine).toBeUndefined()
})

it('keeps own-change nonauthoritative through failed post-rename cleanup and never replays old retirement against U', async () => {
  await install('X')
  seam.after = async (method, path) => {
    if (method === 'rename' && path === file('X')) {
      throw failure()
    }
  }
  expect((await install('X', { claudeVersion: '1.0.0' })).state).toBe('error')
  expect((await read(file('X'))).statusLine).toBeUndefined()
  expect((await document()).destinations[0].phase).toBe('own-change')
  seam.after = null
  await write(file('X'), { statusLine: { type: 'command', command: '/user/replaced' } })
  expect((await install('fresh')).state).toBe('installed')
  expect((await read(file('fresh'))).statusLine).toBeDefined()
  expect((await read(file('X'))).statusLine.command).toBe('/user/replaced')
  expect(
    (await document()).destinations.some((entry: { path: string }) => entry.path === file('X'))
  ).toBe(false)
  await install('Y')
  seam.after = async (method, path) => {
    if (method === 'rename' && path === file('Y')) {
      throw failure()
    }
  }
  expect((await install('Y', { claudeVersion: '1.0.0' })).state).toBe('error')
  seam.after = null
  expect((await install('upgrade')).state).toBe('installed')
  expect((await read(file('upgrade'))).statusLine).toBeDefined()
})

it('journals own retirement, recovers without replay, and does not retire a genuine deletion', async () => {
  await install('X')
  const meta = await documentPath()
  seam.before = async (method, path) => {
    if (method === 'rename' && path === meta) {
      throw failure()
    }
  }
  expect((await install('X', { claudeVersion: '1.0.0' })).state).toBe('error')
  expect((await read(file('X'))).statusLine).toBeDefined()
  seam.before = null
  let live = true
  seam.after = async (method, path) => {
    if (method === 'rename' && path === meta) {
      live = false
    }
  }
  expect(
    (
      await service().installSystem({
        claudeVersion: '1.0.0',
        target: { kind: 'system-default', configDir: dirname(file('X')) },
        shouldContinue: () => live
      })
    ).state
  ).toBe('error')
  expect((await read(file('X'))).statusLine).toBeDefined()
  expect((await document()).destinations[0].phase).toBe('managed')
  seam.after = null
  seam.before = async (method, path) => {
    if (method === 'rename' && path === file('X')) {
      throw failure()
    }
  }
  expect((await install('X', { claudeVersion: '1.0.0' })).state).toBe('error')
  expect((await document()).destinations[0].phase).toBe('own-change')
  seam.before = null
  expect((await install('Y')).state).toBe('installed')
  expect(
    (await document()).destinations.find((entry: { path: string }) => entry.path === file('X'))
      .phase
  ).toBe('managed')
  await install('X', { claudeVersion: '1.0.0' })
  expect((await read(file('X'))).statusLine).toBeUndefined()
  await install('X')
  expect((await read(file('X'))).statusLine).toBeDefined()
  await erase('X')
  await install('X', { claudeVersion: '1.0.0' })
  await install('Z')
  expect((await read(file('Z'))).statusLine).toBeUndefined()
})

it('does not manufacture deletion when a missing recorded file is recreated, and fails safely on journal error', async () => {
  await install('X')
  await fs.unlink(file('X'))
  const meta = await documentPath()
  seam.before = async (method, path) => {
    if (method === 'rename' && path === meta) {
      throw failure()
    }
  }
  const failed = await install('X')
  expect(failed.state).toBe('error')
  expect(failed.managedHooksPresent).toBe(false)
  await expect(fs.readFile(file('X'))).rejects.toMatchObject({ code: 'ENOENT' })
  const others = await applyAgentStatusHooksEnabled(true, null, {
    agents: ['claude', 'gemini'],
    env: { CLAUDE_CONFIG_DIR: dirname(file('X')) }
  })
  expect(others.map((entry) => entry.state)).toEqual(['error', 'installed'])
  await expect(fs.readFile(file('X'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await read(join(seam.home, '.gemini/settings.json'))).hooks).toBeDefined()
  seam.before = null
  expect((await install('X', { claudeVersion: '1.0.0' })).state).toBe('installed')
  expect((await read(file('X'))).statusLine).toBeUndefined()
  expect((await install('Y')).state).toBe('installed')
  expect((await read(file('Y'))).statusLine).toBeDefined()
  await erase('Y')
  await install('Y', { claudeVersion: '1.0.0' })
  await install('Z')
  expect((await read(file('Z'))).statusLine).toBeUndefined()
})

it('resets authority before removals and verifies uncertain metadata publication without reviving backups', async () => {
  await install('X')
  const meta = await documentPath()
  const before = await document()
  seam.before = async (method, path) => {
    if (method === 'rename' && path === meta) {
      throw failure()
    }
  }
  expect((await remove('X')).state).toBe('error')
  expect((await read(file('X'))).statusLine).toBeDefined()
  expect(await document()).toEqual(before)
  seam.before = async (method, path) => {
    if (method === 'rename' && path === file('X')) {
      throw failure()
    }
  }
  expect((await remove('X')).state).toBe('error')
  expect((await document()).destinations).toEqual([])
  seam.before = null
  await install('X')
  seam.after = async (method, path) => {
    if (method === 'rename' && path === meta) {
      throw failure()
    }
  }
  expect((await remove('X')).state).toBe('not_installed')
  seam.after = null
  expect((await document()).destinations).toEqual([])
  expect((await document()).revision).not.toBe(before.revision)
})

it('bounds abandoned history, lets events and later installers progress, and retries only on a legitimate wake', async () => {
  await install('X')
  await install('Y')
  await install('deleted-last')
  await erase('deleted-last')
  let release!: () => void
  const stalled = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const admitted = new Promise<void>((resolve) => {
    entered = resolve
  })
  let active = 0,
    maxActive = 0
  seam.before = async (method, path) => {
    if (method !== 'readFile' || ![file('X'), file('Y')].includes(path)) {
      return
    }
    maxActive = Math.max(maxActive, ++active)
    if (active === 2) {
      entered()
    }
    await stalled
    active--
  }
  const started = performance.now()
  const pending = install('fresh')
  await admitted
  const eventsMs = performance.now() - started
  expect((await read(file('fresh'))).hooks.SessionStart).toHaveLength(1)
  let timerRan = false
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      timerRan = true
      resolve()
    }, 0)
  )
  expect(timerRan).toBe(true)
  expect((await pending).detail).toContain('incomplete')
  const elapsed = performance.now() - started
  expect((await install('second')).detail).toContain('still being inspected')
  expect(maxActive).toBe(2)
  expect((await read(file('second'))).statusLine).toBeUndefined()
  await remove('fresh')
  const reset = await fs.readFile(await documentPath(), 'utf8')
  release()
  await new Promise((resolve) => setImmediate(resolve))
  seam.before = null
  expect(await fs.readFile(await documentPath(), 'utf8')).toBe(reset)
  expect((await install('fresh')).state).toBe('installed')
  expect((await read(file('fresh'))).statusLine).toBeDefined()
  console.log('SL_INCOMPLETE', JSON.stringify({ elapsed, eventsMs, maxActive }))
})

it('restores after a complete observed-unknown pass, while keeping the unfinished I/O cohort occupied', async () => {
  await install('X')
  let release!: () => void
  const stalled = new Promise<void>((resolve) => {
    release = resolve
  })
  seam.before = async (method, path) => {
    if (method === 'readFile' && path === file('X')) {
      await stalled
    }
  }
  const started = performance.now()
  expect((await install('fresh')).state).toBe('installed')
  expect((await read(file('fresh'))).statusLine).toBeDefined()
  expect((await install('another')).detail).toContain('still being inspected')
  release()
  await new Promise((resolve) => setImmediate(resolve))
  seam.before = null
  expect((await install('another')).state).toBe('installed')
  console.log('SL_OBSERVED_UNKNOWN', JSON.stringify({ elapsed: performance.now() - started }))
})

it('runs desktop controls and actual online/offline CLI on/off with independent invocation roots', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errors = vi.spyOn(console, 'error')
  const env = { CLAUDE_CONFIG_DIR: dirname(file('X')) }
  expect(
    (await applyAgentStatusHooksEnabled(true, null, { agents: ['claude'], env }))[0].state
  ).toBe('installed')
  vi.stubEnv('CLAUDE_CONFIG_DIR', dirname(file('Y')))
  await main(['agent', 'hooks', 'on', '--json'])
  expect((await read(file('Y'))).statusLine).toBeDefined()
  await erase('X')
  seam.online = false
  await fs.mkdir(join(seam.home, 'data'), { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', dirname(file('Z')))
  await main(['agent', 'hooks', 'on', '--json'])
  expect((await read(file('Z'))).statusLine).toBeUndefined()
  await main(['agent', 'hooks', 'off', '--json'])
  await main(['agent', 'hooks', 'on', '--json'])
  expect((await read(file('Z'))).statusLine).toBeDefined()
  expect(errors).not.toHaveBeenCalled()
  expect(output).toHaveBeenCalled()
  expect(process.exitCode).toBeUndefined()
  const invocation = { agents: ['claude'] as const, env: { CLAUDE_CONFIG_DIR: dirname(file('Z')) } }
  expect(
    (
      await applyAgentStatusHooksEnabled(false, null, {
        ...invocation,
        shouldContinue: () => false
      })
    )[0].state
  ).toBe('not_installed')
  expect((await read(file('Z'))).statusLine).toBeUndefined()
  expect((await document()).destinations).toEqual([])
  expect(
    (
      await applyAgentStatusHooksEnabled(true, null, { ...invocation, shouldContinue: () => true })
    )[0].state
  ).toBe('installed')
  expect((await read(file('Z'))).statusLine).toBeDefined()
})

it('joins real installers in registry order while Claude waits, cancels final admission, then rederives on a new apply', async () => {
  await install('X')
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  seam.before = async (method, path) => {
    if (method === 'readFile' && path === file('X')) {
      entered()
      await blocked
    }
  }
  const controller = new AbortController()
  const started = performance.now()
  const options = {
    agents: ['claude', 'gemini'] as const,
    env: { CLAUDE_CONFIG_DIR: dirname(file('target')) },
    signal: controller.signal
  }
  const pending = applyAgentStatusHooksEnabled(true, null, options)
  await ready
  expect((await read(join(seam.home, '.gemini/settings.json'))).hooks).toBeDefined()
  const nextAgentMs = performance.now() - started
  controller.abort()
  const results = await pending
  expect(results.map((entry) => entry.agent)).toEqual(['claude', 'gemini'])
  expect(results.map((entry) => entry.state)).toEqual(['error', 'installed'])
  expect((await read(file('target'))).statusLine).toBeUndefined()
  release()
  await new Promise((resolve) => setImmediate(resolve))
  seam.before = null
  const retry = await applyAgentStatusHooksEnabled(true, null, { ...options, signal: undefined })
  expect(retry.map((entry) => entry.state)).toEqual(['installed', 'installed'])
  expect((await read(file('target'))).statusLine).toBeDefined()
  let live = true
  seam.after = async (method, path) => {
    if (method === 'readFile' && path === file('X')) {
      live = false
    }
  }
  const guarded = await applyAgentStatusHooksEnabled(true, null, {
    ...options,
    signal: undefined,
    env: { CLAUDE_CONFIG_DIR: dirname(file('guarded')) },
    shouldContinue: () => live
  })
  expect(guarded[0].state).toBe('error')
  expect((await read(file('guarded'))).statusLine).toBeUndefined()
  seam.after = null
  expect(
    (
      await applyAgentStatusHooksEnabled(true, null, {
        ...options,
        signal: undefined,
        env: { CLAUDE_CONFIG_DIR: dirname(file('guarded')) }
      })
    )[0].state
  ).toBe('installed')
  console.log('SL_NEXT_AGENT', JSON.stringify({ nextAgentMs }))
})
