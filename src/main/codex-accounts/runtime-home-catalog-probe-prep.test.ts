import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type * as NodeOs from 'node:os'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createStore,
  getRuntimeCodexAuthPath,
  getRuntimeCodexHomePath,
  getSystemCodexAuthPath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'
import type { CodexRuntimeHomeService } from './runtime-home-service'

vi.mock('../codex/codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const login = createCodexAuthJson('me@example.com', 'acct-me', 'external-login')

async function mirrorRouteService(): Promise<CodexRuntimeHomeService> {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only getSettings/updateSettings, which the harness store implements.
  return new CodexRuntimeHomeService(createStore(createSettings()) as never)
}

function loginInSystemHome(): void {
  mkdirSync(dirname(getSystemCodexAuthPath()), { recursive: true })
  writeFileSync(getSystemCodexAuthPath(), login, 'utf-8')
}

describe("the catalog probe's home prep on the mirror route", () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it('reads current System login without seeding a mirror or future actor', async () => {
    const service = await mirrorRouteService()
    loginInSystemHome()
    const home = service.resolveHostCodexHomePathForLaunchReadOnly()
    expect(home ?? join(testState.fakeHomeDir, '.codex')).toBe(
      join(testState.fakeHomeDir, '.codex')
    )
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf8')).toBe(login)
  })

  it('retains a supplied actual actor without reseeding its missing auth', async () => {
    const service = await mirrorRouteService()
    loginInSystemHome()
    const actor = service.prepareForCodexLaunch(
      undefined,
      {},
      { conversationHome: getRuntimeCodexHomePath() }
    )!
    const { unlinkSync } = await import('node:fs')
    unlinkSync(join(actor, 'auth.json'))
    expect(service.resolveHostCodexHomePathForLaunchReadOnly({}, actor)).toBe(actor)
    expect(existsSync(join(actor, 'auth.json'))).toBe(false)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf8')).toBe(login)
  })
})
