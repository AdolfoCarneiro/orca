import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const statMock = vi.hoisted(() => vi.fn<(path: string) => Promise<{ isDirectory(): boolean }>>())
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock
}))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  createFolderWorkspaceRuntimeStore,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  TEST_FOLDER_WORKSPACE_KEY
} = await import('./orca-runtime-test-fixtures.spec')
const { blockedWslDistroForPath } = await import('../wsl/wsl-unc-access-gate')
const { isWslUserActFor } = await import('../wsl/wsl-user-act-scope')

const PARENT = '\\\\wsl.localhost\\Ubuntu\\home\\me'
const FOLDER = `${PARENT}\\notes`
const hostPlatform = process.platform
const statsInUserAct: boolean[] = []

function makeRuntime(): InstanceType<typeof OrcaRuntimeService> {
  return new OrcaRuntimeService(
    createFolderWorkspaceRuntimeStore(
      makeFolderWorkspace({ folderPath: FOLDER }),
      makeFolderProjectGroup({ parentPath: PARENT })
    )
  )
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  statsInUserAct.length = 0
  statMock.mockReset()
  statMock.mockImplementation(async () => {
    statsInUserAct.push(isWslUserActFor('Ubuntu'))
    return { isDirectory: () => true }
  })
  // Stopped, as the real gate reads it: only the user's act on the distro passes.
  vi.mocked(blockedWslDistroForPath).mockImplementation(async () =>
    isWslUserActFor('Ubuntu') ? null : { distro: 'Ubuntu', state: 'stopped' }
  )
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  vi.mocked(blockedWslDistroForPath).mockReset()
  vi.mocked(blockedWslDistroForPath).mockResolvedValue(null)
})

describe('a runtime start in a folder workspace on a stopped WSL distro (E9)', () => {
  it("checks the folder as the user's act, which may start the distro", async () => {
    await expect(
      makeRuntime().resolveTerminalWorkspaceLaunchScope(
        `id:${TEST_FOLDER_WORKSPACE_KEY}`,
        undefined,
        {
          wslUserAct: true
        }
      )
    ).resolves.toMatchObject({ id: TEST_FOLDER_WORKSPACE_KEY, path: FOLDER })
    expect(statsInUserAct).toEqual([true])
  })

  it('treats a deduplicated CLI create as the user act too', async () => {
    const run = vi.fn(async () => ({ handle: 'term-1' }))
    await makeRuntime().dedupeTerminalCreate(
      'local',
      `id:${TEST_FOLDER_WORKSPACE_KEY}`,
      'mutation-1',
      false,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dedupe returns `run`'s result untouched; only the launch scope is under test.
      run as never,
      { wslUserAct: true }
    )
    expect(statsInUserAct).toEqual([true])
    expect(run).toHaveBeenCalledOnce()
  })

  it('refuses background work by naming the stopped distro, without touching the folder', async () => {
    await expect(
      makeRuntime().resolveTerminalWorkspaceLaunchScope(`id:${TEST_FOLDER_WORKSPACE_KEY}`)
    ).rejects.toThrow("WSL distro 'Ubuntu' is not running")
    expect(statMock).not.toHaveBeenCalled()
  })
})
