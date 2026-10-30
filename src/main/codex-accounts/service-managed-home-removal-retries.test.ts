import { describe, expect, it, vi, beforeEach } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { existsSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import {
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexAccountService config sync', () => {
  registerCodexAccountsTestHomes()

  it('retains legacy stores without recursively removing their trees', async () => {
    vi.resetModules()
    const actualFs = await vi.importActual<typeof NodeFs>('node:fs')
    const rmSyncSpy = vi.fn(actualFs.rmSync)
    vi.doMock('node:fs', () => ({ ...actualFs, rmSync: rmSyncSpy }))

    try {
      // Match ownership canonicalization, including /private/var paths on macOS.
      const managedHomePath = actualFs.realpathSync(
        createManagedHome(testState.userDataDir, 'account-1')
      )
      const store = createStore(createSettings())
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      ;(
        service as unknown as {
          safeRemoveManagedHome(candidatePath: string, expectedAccountId: string): void
        }
      ).safeRemoveManagedHome(managedHomePath, 'account-1')

      expect(existsSync(managedHomePath)).toBe(true)
      expect(rmSyncSpy.mock.calls.some(([target]) => target === managedHomePath)).toBe(false)
    } finally {
      vi.doUnmock('node:fs')
    }
  })
  it.each(['transient', 'permanent'])(
    'selectively revokes private targets with %s locks and unreadable family child, retaining stores and outside links',
    async (mode) => {
      vi.resetModules()
      const fs = await vi.importActual<typeof NodeFs>('node:fs')
      const { join, dirname } = await import('node:path')
      const H = fs.realpathSync(createManagedHome(testState.userDataDir, 'account-1'))
      const family = dirname(H)
      const A = join(family, 'overlays', 'a'.repeat(32))
      const B = join(family, 'overlays', 'b'.repeat(32))
      const outside = join(testState.userDataDir, 'outside')
      for (const path of [A, B, outside, join(H, '.orca-reauth-login'), join(H, 'sessions')]) {
        fs.mkdirSync(path, { recursive: true })
      }
      fs.writeFileSync(join(outside, 'keep'), 'outside')
      for (const O of [A, B]) {
        fs.symlinkSync(join(H, 'sessions'), join(O, 'sessions'), 'dir')
        fs.writeFileSync(join(O, 'auth.json'), 'private')
        fs.writeFileSync(join(O, 'session_index.jsonl'), 'index')
        fs.writeFileSync(join(O, 'state_5.sqlite'), 'native-db')
      }
      fs.symlinkSync(outside, join(B, 'outside-link'), 'dir')
      fs.writeFileSync(join(H, 'auth.json'), 'private-root')
      fs.writeFileSync(join(H, 'auth.lock'), 'lock')
      fs.writeFileSync(join(H, '.orca-reauth-login', 'auth.json'), 'staging')
      const target = join(H, 'auth.json')
      const deniedChild = A
      let unlinks = 0,
        childReads = 0
      vi.stubGlobal('Atomics', { ...Atomics, wait: vi.fn(() => 'timed-out') })
      vi.doMock('node:fs', () => ({
        ...fs,
        lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
          if (String(args[0]) === deniedChild) {
            childReads++
            throw Object.assign(new Error('child busy'), { code: 'EBUSY' })
          }
          return fs.lstatSync(...args)
        },
        unlinkSync: (path: string) => {
          if (path === target) {
            unlinks++
            if (mode === 'permanent' || unlinks < 3) {
              throw Object.assign(new Error('private busy'), { code: 'EBUSY' })
            }
          }
          return fs.unlinkSync(path)
        }
      }))
      // SAFETY: platform is restored before fixture teardown; only Windows retry policy is modeled.
      const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const { CodexManagedHomeLifecycle } = await import('./codex-managed-home-lifecycle')
        const { CodexManagedHomePath } = await import('./codex-managed-home-path')
        const lifecycle = new CodexManagedHomeLifecycle(
          new CodexManagedHomePath(() => {
            throw new Error('WSL not exercised')
          })
        )
        lifecycle.safeRemove(H, 'account-1')
        expect(unlinks).toBe(mode === 'permanent' ? 9 : 3)
        expect(childReads).toBe(9)
        expect(fs.existsSync(join(H, 'auth.lock'))).toBe(false)
        expect(fs.existsSync(join(H, '.orca-reauth-login'))).toBe(false)
        expect(fs.existsSync(join(B, 'auth.json'))).toBe(false)
        expect(fs.existsSync(join(B, 'outside-link'))).toBe(false)
        expect(fs.readFileSync(join(outside, 'keep'), 'utf8')).toBe('outside')
        for (const O of [A, B]) {
          expect(fs.readFileSync(join(O, 'session_index.jsonl'), 'utf8')).toBe('index')
          expect(fs.readFileSync(join(O, 'state_5.sqlite'), 'utf8')).toBe('native-db')
          expect(fs.readlinkSync(join(O, 'sessions'))).toBe(join(H, 'sessions'))
        }
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        platform.mockRestore()
        warn.mockRestore()
        vi.unstubAllGlobals()
        vi.doUnmock('node:fs')
      }
    }
  )
})
