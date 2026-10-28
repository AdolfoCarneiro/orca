import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn((_path: string) => false),
  runningSettled: vi.fn((_distro: string) => false)
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  existsSync: mocks.existsSync
}))
vi.mock('../wsl-background-distro-gate', () => ({
  wasWslDistroLastSeenRunningSettled: mocks.runningSettled
}))

import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import { CodexConfigMirror } from './codex-config-mirror'
import { runAsWslUserAct } from '../wsl/wsl-user-act-scope'

const WSL_HOME =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-accounts\\acct\\home'

const SETTINGS = createGlobalSettingsFixture({
  codexManagedAccounts: [
    {
      id: 'acct',
      email: 'wsl@example.com',
      managedHomePath: WSL_HOME,
      managedHomeRuntime: 'wsl',
      wslDistro: 'Ubuntu',
      wslLinuxHomePath: '/home/ada/.local/share/orca/codex-accounts/acct/home',
      providerAccountId: null,
      workspaceLabel: null,
      workspaceAccountId: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
  ]
})

function mirror(): CodexConfigMirror {
  return new CodexConfigMirror({ getSettings: () => SETTINGS }, (path) => path)
}

const uncTouches = (): number =>
  mocks.existsSync.mock.calls.filter(([path]) => String(path).startsWith('\\\\wsl')).length

beforeEach(() => {
  mocks.existsSync.mockClear()
  mocks.runningSettled.mockReset().mockReturnValue(false)
})

describe('Codex config mirror never boots a stopped WSL distro (E9)', () => {
  it('leaves a WSL account home alone at startup when its distro is not seen running', () => {
    mirror().safeSyncToManagedHomes()
    expect(uncTouches()).toBe(0)
    expect(mocks.runningSettled).toHaveBeenCalledWith('Ubuntu')
  })

  it('syncs a WSL account home whose distro was seen running after any stop', () => {
    mocks.runningSettled.mockReturnValue(true)
    mirror().safeSyncToManagedHomes()
    expect(uncTouches()).toBe(1)
  })

  it('syncs during a user act on that distro, which may start it', async () => {
    await runAsWslUserAct('Ubuntu', async () => mirror().safeSyncToManagedHomes())
    expect(uncTouches()).toBe(1)
  })
})
