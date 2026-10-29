import { build } from 'esbuild'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import {
  setIsolatedSpawner,
  spawnDetachedWithoutInheritance
} from '@orca/process-host/isolated-detached-spawn'
import { loadWindowsSecurity } from '../../shared/windows-security-addon'

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip
const ADDON = resolve(__dirname, '..', '..', '..', 'native', 'windows-security', 'index.js')
const root = mkdtempSync(join(tmpdir(), 'orca-isolated-spawn-'))
const entry = join(root, 'main.cjs')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Runs the Electron fixture; reports whether its holder outlived the fixture's stdout pipe. */
async function runElectron(mode: 'isolated' | 'libuv', holderMs: number) {
  const electron: unknown = createRequire(import.meta.url)('electron')
  if (typeof electron !== 'string') {
    throw new Error('Electron executable is unavailable')
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const resultFile = join(root, `${mode}.result`)
  const child = spawnProcess({
    program: electron,
    args: [entry, ADDON, mode, String(holderMs), resultFile],
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout?.on('data', (chunk) => (output += chunk))
  child.stderr?.on('data', (chunk) => (output += chunk))
  const [code] = await once(child, 'close', { signal: AbortSignal.timeout(holderMs + 30_000) })
  const result = readFileSync(resultFile, 'utf8')
  const holderPid = Number(result)
  const holderAliveAtClose = isAlive(holderPid)
  if (holderAliveAtClose) {
    process.kill(holderPid)
  }
  return { code, output, result, holderAliveAtClose }
}

describeOnWindows('isolated detached spawn against real Windows processes', () => {
  beforeAll(async () => {
    await build({
      entryPoints: [resolve(__dirname, 'windows-isolated-spawn-electron-fixture.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      conditions: ['orca-source'],
      external: ['electron'],
      logLevel: 'silent'
    })
    const security = loadWindowsSecurity()
    if ('error' in security) {
      throw new Error(`the windows-security addon did not load: ${security.error}`)
    }
    setIsolatedSpawner(security.addon.spawnDetachedIsolated)
  })

  afterAll(() => {
    setIsolatedSpawner(null)
    rmSync(root, { recursive: true, force: true })
  })

  // A cold Node start on a loaded Windows runner can exceed the 5 s default.
  it('passes argv through unchanged and reports the exit code', async () => {
    const argvFile = join(root, 'argv.json')
    const tricky = ['plain', 'with space', 'quote"inside', 'back\\slash', 'trail\\', 'x \\"y', '']
    const child = spawnDetachedWithoutInheritance({
      program: process.execPath,
      args: [
        '-e',
        'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))); process.exit(7)',
        argvFile,
        ...tricky
      ],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    const [code] = await once(child, 'exit', { signal: AbortSignal.timeout(20_000) })

    expect(code).toBe(7)
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(tricky)
  }, 30_000)

  it('reports a missing program as an error event', async () => {
    const child = spawnDetachedWithoutInheritance({
      program: join(root, 'missing.exe')
    })
    const [error] = await once(child, 'error', { signal: AbortSignal.timeout(5_000) })

    expect(String(error)).toContain('CreateProcessW failed with Win32 error 2')
  })

  // Cold Electron start on a CI runner; a regression pins the pipe for the 60 s holder.
  it('keeps an Electron main pipe away from a detached holder', async () => {
    const run = await runElectron('isolated', 60_000)

    expect(run.code, run.output).toBe(0)
    expect(run.result).toMatch(/^\d+$/)
    expect(run.holderAliveAtClose).toBe(true)
  }, 90_000)

  // Cold Electron start on a CI runner plus the 3 s holder exceeds the 5 s default.
  it('without it, the libuv holder pins the pipe until it exits (control)', async () => {
    const run = await runElectron('libuv', 3_000)

    expect(run.code, run.output).toBe(0)
    expect(run.holderAliveAtClose).toBe(false)
  }, 60_000)
})
