import { expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  seam,
  file,
  read,
  write,
  install,
  remove,
  erase,
  documentPath,
  document,
  resetService
} from './claude-system-statusline.test-fixture'
it('measures real production adoption and System decisions at 100 and 1000 physical owners', async () => {
  const base = seam.home
  const rows: Record<string, number>[] = []
  for (const population of [100, 1000]) {
    seam.home = join(base, `N${String(population).padStart(4, '0')}`)
    await fs.mkdir(seam.home)
    vi.stubEnv('HOME', seam.home)
    vi.stubEnv('USERPROFILE', seam.home)
    await resetService()
    seam.probes = 0
    expect((await install('r0000')).state).toBe('installed')
    const coldProbes = seam.probes
    const template = await read(file('r0000'))
    const corpus = new Set([file('r0000')])
    for (let index = 1; index < population; index++) {
      const name = `r${String(index).padStart(4, '0')}`
      await write(file(name), template)
      expect((await install(name)).state).toBe('installed')
      corpus.add(file(name))
    }
    expect((await document()).destinations).toHaveLength(population)
    for (let index = 0; index < population; index++) {
      await fs.writeFile(join(seam.home, '.orca', `unrelated-${index}`), '')
    }
    const meta = await documentPath()
    const measure = async (action: () => Promise<unknown>) => {
      seam.calls = new Map()
      seam.bytes = new Map()
      seam.probes = 0
      let last = performance.now(),
        maxDelay = 0
      const timer = setInterval(() => {
        const now = performance.now()
        maxDelay = Math.max(maxDelay, now - last)
        last = now
      }, 1)
      const start = performance.now()
      await action()
      const elapsed = performance.now() - start
      clearInterval(timer)
      const count = (method: string, accepts: (path: string) => boolean, source = seam.calls) =>
        [...source!].reduce(
          (sum, [key, n]) =>
            sum + (key.startsWith(`${method}:`) && accepts(key.slice(method.length + 1)) ? n : 0),
          0
        )
      const row = {
        population,
        elapsed,
        maxDelay,
        historyReads: count('readFile', (path) => corpus.has(path)),
        historyBytes: count('readFile', (path) => corpus.has(path), seam.bytes),
        indexReads: count('readFile', (path) => path === meta),
        indexReadBytes: count('readFile', (path) => path === meta, seam.bytes),
        serializedBytes: count('writeFile', (path) => path.startsWith(`${meta}.`), seam.bytes),
        indexBackupBytes: count('copyFile', (path) => path.startsWith(`${meta}.bak.`), seam.bytes),
        settingsWrites: count('rename', (path) => path.endsWith('/settings.json')),
        settingsSerializedBytes: count(
          'writeFile',
          (path) => path.includes('/settings.json.') && !path.includes('.bak.'),
          seam.bytes
        ),
        indexWrites: count('rename', (path) => path === meta),
        stats: count('stat', () => true),
        realpaths: count('realpath', () => true),
        unrelatedNames: count('readdir', (path) => path === join(seam.home, '.orca')),
        lockListings: count('readdir', (path) => path.endsWith('/lock')),
        lockAttempts: count('link', (path) => path.endsWith('managed-hook-install.lock')),
        probes: seam.probes
      }
      seam.calls = seam.bytes = null
      expect(row.unrelatedNames).toBe(0)
      return row
    }
    const unchanged = await document()
    const m = await measure(async () => {
      expect((await install('r0000')).state).toBe('installed')
    })
    expect(m.historyReads).toBe(3) // Current read, publisher equality read and positive readback only; no other owner is inspected.
    expect(m.indexReads).toBe(1)
    expect(m.indexWrites).toBe(0)
    expect(await document()).toEqual(unchanged)
    await write(file('user'), { statusLine: { type: 'command', command: '/user/owned' } })
    const u = await measure(() => install('user'))
    expect(u.historyReads).toBe(0)
    expect(u.indexReads).toBe(0)
    const allM = await measure(async () => {
      expect((await install('fresh')).state).toBe('installed')
    })
    expect(allM.historyReads).toBe(population)
    expect((await read(file('fresh'))).statusLine).toBeDefined()
    const retire = await measure(() => install('fresh', { claudeVersion: '1.0.0' }))
    expect(retire.historyReads).toBe(0)
    const last = `r${String(population - 1).padStart(4, '0')}`
    await erase(last)
    const deletion = await measure(async () => {
      expect((await install('fresh')).state).toBe('installed')
    })
    expect((await read(file('fresh'))).statusLine).toBeUndefined()
    expect(deletion.historyReads).toBe(population + 1) // Last witness is rechecked under the transaction scope.
    expect(deletion.elapsed).toBeLessThan(2000)
    expect(deletion.maxDelay).toBeLessThan(50)
    await fs.writeFile(file(last), 'null')
    const unknown = await measure(async () => {
      expect((await install('fresh')).state).toBe('installed')
    })
    expect(unknown.historyReads).toBe(population)
    expect((await read(file('fresh'))).statusLine).toBeDefined()
    expect(unknown.elapsed).toBeLessThan(2000)
    expect(unknown.maxDelay).toBeLessThan(50)
    await install('fresh', { claudeVersion: '1.0.0' })
    const deleted = { ...template }
    delete deleted.statusLine
    await write(file(last), deleted)
    const big = await read(file('r0000'))
    big.largeControl = 'x'.repeat(256 * 1024)
    await write(file('r0000'), big)
    const large = await measure(() => install('fresh'))
    const reset = await measure(() => remove('fresh'))
    expect(reset.historyReads).toBe(0)
    expect(reset.indexWrites).toBe(1)
    expect(reset.indexBackupBytes).toBeGreaterThan(200 * population)
    rows.push(allM)
    console.log(
      'SL_PERF',
      JSON.stringify({
        coldProbes,
        corpusBytes: allM.historyBytes,
        settingsPathBytes: Buffer.byteLength(file('r0000')),
        m,
        u,
        allM,
        deletion,
        unknown,
        retire,
        large,
        reset
      })
    )
  }
  for (const key of [
    'historyReads',
    'indexReadBytes',
    'serializedBytes',
    'stats',
    'realpaths',
    'lockAttempts'
  ]) {
    expect(rows[1][key]).toBeLessThanOrEqual(10 * rows[0][key] + 2048)
  }
  seam.home = base
}, 60_000)
