import { afterEach, describe, expect, it, vi } from 'vitest'

const loginShell = vi.hoisted(() => ({
  resolveLoginShellEnvironment: vi.fn(async (_options?: { env?: NodeJS.ProcessEnv }) => ({}))
}))
vi.mock('../startup/login-shell-environment', () => loginShell)

import {
  adoptWslHostLoginEnvironment,
  settleWithin,
  wslHostLoginEnvironmentOverlay
} from './orcad-wsl-host-login-environment'

const shellEnv: NodeJS.ProcessEnv = {
  SSH_AUTH_SOCK: '/home/u/.ssh/agent.sock',
  https_proxy: 'http://proxy.internal:3128',
  GNUPGHOME: '/home/u/.gnupg',
  PATH: '/home/u/.local/bin:/usr/bin',
  GIT_ASKPASS: '/usr/bin/ksshaskpass',
  WSL_INTEROP: '/run/WSL/99_interop',
  SECRET_FROM_RC: 'nope'
}

describe('wslHostLoginEnvironmentOverlay', () => {
  it('takes only allowlisted variables, leaving PATH, askpass and interop to their owners', () => {
    expect(wslHostLoginEnvironmentOverlay(shellEnv, { PATH: '/usr/bin' })).toEqual({
      SSH_AUTH_SOCK: '/home/u/.ssh/agent.sock',
      https_proxy: 'http://proxy.internal:3128',
      GNUPGHOME: '/home/u/.gnupg'
    })
  })

  it('lets the login shell win over a different launch value, as `$SHELL -ilc` did', () => {
    expect(
      wslHostLoginEnvironmentOverlay(
        { SSH_AUTH_SOCK: '/rc/agent.sock', GNUPGHOME: '/same' },
        { SSH_AUTH_SOCK: '/launch/agent.sock', GNUPGHOME: '/same' }
      )
    ).toEqual({ SSH_AUTH_SOCK: '/rc/agent.sock' })
  })
})

describe('adoptWslHostLoginEnvironment', () => {
  it('applies the overlay to the env on a WSL host and reports the names', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const names = await adoptWslHostLoginEnvironment(
      env,
      async () => shellEnv,
      () => true
    )
    expect(names).toEqual(['SSH_AUTH_SOCK', 'GNUPGHOME', 'https_proxy'])
    expect(env).toEqual({
      PATH: '/usr/bin',
      SSH_AUTH_SOCK: '/home/u/.ssh/agent.sock',
      GNUPGHOME: '/home/u/.gnupg',
      https_proxy: 'http://proxy.internal:3128'
    })
  })

  it('probes with the PATH probe marker, so an rc that skips `exec tmux` for it still exports', async () => {
    await adoptWslHostLoginEnvironment({ HOME: '/home/u' }, undefined, () => true)
    expect(loginShell.resolveLoginShellEnvironment).toHaveBeenCalledWith({
      env: { HOME: '/home/u', ORCA_SHELL_PATH_PROBE: '1' },
      timeoutMs: 10_000
    })
  })

  it('never probes the login shell off a WSL host', async () => {
    const resolve = vi.fn(async () => shellEnv)
    const env: NodeJS.ProcessEnv = {}
    expect(await adoptWslHostLoginEnvironment(env, resolve, () => false)).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
    expect(env).toEqual({})
  })
})

describe('settleWithin', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns as soon as the login env lands, and leaves no timer behind', async () => {
    vi.useFakeTimers()
    let settled = false
    const waiting = settleWithin(Promise.resolve(['SSH_AUTH_SOCK']), 50).then(() => {
      settled = true
    })

    await waiting

    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up at the cap on a slow login shell, without waiting for it', async () => {
    vi.useFakeTimers()
    let settled = false
    const waiting = settleWithin(new Promise(() => {}), 50).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(49)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await waiting

    expect(settled).toBe(true)
  })

  it('treats a failed login env as settled, never as a startup error', async () => {
    await expect(settleWithin(Promise.reject(new Error('shell died')), 50)).resolves.toBeUndefined()
  })
})
