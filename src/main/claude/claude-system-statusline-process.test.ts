import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { spawnProcess } from '@orca/process-host'
import { afterEach, expect, it } from 'vitest'
import { JSONC_PARSER_ESM_ALIAS } from '../../../config/build-plugins/jsonc-parser-esm'
import { isPlainObject } from '../agent-hooks/hooks-json-read'
import { readManagedHookProcessIdentity } from '../agent-hooks/managed-hook-owner-identity'

const roots: string[] = []
const children: { child: ReturnType<typeof spawnProcess>; closed: Promise<unknown> }[] = []
afterEach(async () => {
  for (const { child } of children) {
    if (child.connected) {
      child.send('shutdown')
    }
  }
  await Promise.all(children.splice(0).map(({ closed }) => closed))
  for (const path of roots.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pr31199-sl-process-')))
  roots.push(root)
  const home = join(root, 'home')
  await mkdir(home)
  const entry = join(root, 'entry.cjs')
  await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import { ClaudeHookService } from './src/main/claude/hook-service';
        import { barrier, metrics } from 'statusline-test-barrier';
        import { probeMetrics } from 'statusline-test-probes';
        import { tryCreateManagedHookLock } from './src/main/agent-hooks/managed-hook-lock-records';
        import { readManagedHookHostIdentity, readManagedHookProcessIdentity } from './src/main/agent-hooks/managed-hook-owner-identity';
        import { mkdir, unlink } from 'node:fs/promises';
        import { join } from 'node:path';
        import { setAppEnvironment } from './src/shared/app-environment';
        setAppEnvironment({ getPath: () => process.env.HOME, getAppPath: () => process.cwd(), getVersion: () => 'test', isPackaged: () => false, onWillQuit: () => {}, exit: code => process.exit(code), getAppMetrics: () => [] });
        const [target, operation, mode] = process.argv.slice(2);
        const controller = new AbortController();
        process.on('message', m => { if (m === 'cancel' || m === 'shutdown') controller.abort(); });
        process.on('disconnect', () => process.exit(0));
        const options = { target: { kind: 'system-default', configDir: target }, signal: controller.signal, claudeVersion: operation === 'retire' ? '1.0.0' : '2.1.261' };
        process.send?.({ phase: 'started', pid: process.pid });
        const service = new ClaudeHookService();
        const residues = async () => {
          const parent = join(process.env.HOME, '.orca/agent-hooks/claude-statusline/lock'); await mkdir(parent, { recursive: true });
          const host = await readManagedHookHostIdentity(), identity = await readManagedHookProcessIdentity(process.pid);
          if (!identity) throw new Error('Missing residue creator identity');
          for (let i = 0; i < Number(mode); i++) {
            const lock = join(parent, 'managed-hook-install.lock');
            if (!await tryCreateManagedHookLock(parent, lock, host, identity)) throw new Error('Unexpected residue contention');
            await unlink(lock);
          }
          return { state: 'residues' };
        };
        const start = performance.now();
        const result = operation === 'residues' ? residues() : operation === 'reset' ? service.removeSystem(options) : service.installSystem(options);
        result.then(status => { process.send?.({ phase: 'done', status, metrics: { ...metrics, ...probeMetrics, elapsed: performance.now() - start } }); process.disconnect(); });
        void barrier; void mode;`
    },
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: JSONC_PARSER_ESM_ALIAS,
    logLevel: 'silent',
    plugins: [
      {
        name: 'isolated-service-barriers',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
          b.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({
            contents: `export const app = { getPath: () => process.env.HOME };`
          }))
          b.onResolve(
            { filter: /^(node:child_process|statusline-test-probes)$/ },
            ({ namespace }) =>
              namespace === 'probes'
                ? { path: 'node:child_process', external: true }
                : { path: 'probes', namespace: 'probes' }
          )
          b.onLoad({ filter: /.*/, namespace: 'probes' }, () => ({
            contents: `
        export * from 'node:child_process';
        import * as cp from 'node:child_process';
        import { promisify } from 'node:util';
        export const probeMetrics = { probes: 0, outstanding: 0, maxProbes: 0 };
        export function execFile(...args) { return cp.execFile(...args); }
        Object.defineProperty(execFile, promisify.custom, { value: async (...args) => {
          probeMetrics.probes++; probeMetrics.maxProbes = Math.max(probeMetrics.maxProbes, ++probeMetrics.outstanding);
          try { return await promisify(cp.execFile)(...args); } finally { probeMetrics.outstanding--; }
        }});`
          }))
          b.onResolve(
            { filter: /^(node:fs\/promises|statusline-test-barrier)$/ },
            ({ namespace }) =>
              namespace === 'barrier'
                ? { path: 'node:fs/promises', external: true }
                : { path: 'files', namespace: 'barrier' }
          )
          b.onLoad({ filter: /.*/, namespace: 'barrier' }, () => ({
            contents: `
        export * from 'node:fs/promises';
        import * as fs from 'node:fs/promises';
        const [target, , mode] = process.argv.slice(2);
        let armed = true, resume;
        export const metrics = { lockListings: 0, cleanupNames: 0, rootListings: 0 };
        export async function readdir(path,...args) {
          const names = await fs.readdir(path,...args);
          if (String(path).endsWith('/claude-statusline/lock')) { metrics.lockListings++; metrics.cleanupNames += names.length; }
          if (String(path) === process.env.HOME + '/.orca') metrics.rootListings++;
          return names;
        }
        export const barrier = async phase => {
          if (!armed) return; armed = false;
          process.send?.({ phase }); await new Promise(resolve => { resume = resolve; });
        };
        process.on('message', m => { if (m === 'exit') process.exit(0); if (m === 'continue' || m === 'shutdown') { armed = false; resume?.(); } });
        export async function rename(a,b) {
          await fs.rename(a,b);
          if (String(b) === target + '/settings.json' && mode === 'published' && JSON.parse(await fs.readFile(b,'utf8')).statusLine) await barrier('published');
          if (String(b) === target + '/settings.json' && mode === 'retired' && !JSON.parse(await fs.readFile(b,'utf8')).statusLine) await barrier('retired');
        }
        export async function readFile(path,...args) {
          const data = await fs.readFile(path,...args);
          if (mode === 'snapshot' && String(path) === target + '/settings.json') await barrier('snapshot');
          return data;
        }
        export async function link(a,b) {
          if (mode === 'acquiring' && String(b).endsWith('managed-hook-install.lock')) process.send?.({ phase: 'acquiring' });
          return fs.link(a,b);
        }`
          }))
        }
      }
    ]
  })
  async function start(target: string, operation = 'install', mode = '') {
    const child = spawnProcess({
      program: process.execPath,
      args: [entry, join(home, target), operation, mode],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: '',
        ORCA_CLAUDE_INJECTED_CONFIG_DIR: '',
        ORCA_BACKGROUND_LAUNCH: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    const closed = once(child, 'close')
    children.push({ child, closed })
    const messages: Record<string, unknown>[] = []
    let stderr = ''
    child.stderr?.on('data', (data) => {
      stderr += String(data)
    })
    child.on('message', (message) => {
      if (isPlainObject(message)) {
        messages.push(message)
      }
    })
    const waitForPhase = async (phase: string) => {
      while (!messages.some((m) => m.phase === phase)) {
        await Promise.race([
          once(child, 'message'),
          closed.then(() => {
            throw new Error(`Child exited before ${phase}: ${stderr}`)
          })
        ])
      }
      return messages.find((m) => m.phase === phase)!
    }
    await waitForPhase('started')
    expect(child.pid).toBeGreaterThan(0)
    const identity = await readManagedHookProcessIdentity(child.pid!)
    console.log('SL_OWNED_PROCESS', JSON.stringify({ pid: child.pid, identity }))
    return {
      child,
      closed,
      wait: waitForPhase,
      metrics: async () => (await waitForPhase('done')).metrics,
      done: async () => {
        const result = await waitForPhase('done')
        await closed
        if (!isPlainObject(result.status)) {
          throw new Error('Missing child service status')
        }
        return result.status
      }
    }
  }
  return { root, home, start, settings: (name: string) => join(home, name, 'settings.json') }
}

it.skipIf(process.platform === 'win32')(
  'orders publication, live-owner contention past lease age, canceled admission, reset and abandoned-owner recovery across real processes',
  async () => {
    const f = await fixture()
    expect(f.home).not.toBe(homedir())
    const p = await f.start('X', 'install', 'published')
    await p.wait('published')
    const publishedAt = performance.now()
    // ast-grep-ignore: test-no-real-time-wait -- A real live owner must remain protected beyond the former 10s lease across processes.
    await delay(10_100)
    const q = await f.start('X', 'reset')
    expect((await q.done()).state).toBe('error')
    expect(JSON.parse(await readFile(f.settings('X'), 'utf8')).statusLine).toBeDefined()
    const canceled = await f.start('other', 'install', 'acquiring')
    await canceled.wait('acquiring')
    canceled.child.send('cancel')
    expect((await canceled.done()).state).toBe('error')
    await expect(readFile(f.settings('other'))).rejects.toMatchObject({ code: 'ENOENT' })
    p.child.send('continue')
    expect((await p.done()).state).toBe('installed')
    const reset = await f.start('X', 'reset')
    expect((await reset.done()).state).toBe('not_installed')
    expect(JSON.parse(await readFile(f.settings('X'), 'utf8')).statusLine).toBeUndefined()
    const abandoned = await f.start('X', 'install', 'published')
    await abandoned.wait('published')
    abandoned.child.send('exit')
    await abandoned.closed
    const recovery = await f.start('X')
    expect((await recovery.done()).state).toBe('installed')
    console.log('SL_LIVE_OWNER_PAUSE', performance.now() - publishedAt)
  },
  30_000
)

it.skipIf(process.platform === 'win32')(
  'serializes current event snapshots, off, fresh user slots and retirement across processes',
  async () => {
    const f = await fixture()
    expect((await (await f.start('X')).done()).state).toBe('installed')
    const event = await f.start('X', 'install', 'snapshot')
    await event.wait('snapshot')
    expect((await (await f.start('X', 'reset')).done()).state).toBe('error')
    const user = { statusLine: { type: 'command', command: '/user/new' } }
    event.child.send('continue')
    expect((await event.done()).state).toBe('installed')
    expect((await (await f.start('X', 'reset')).done()).state).toBe('not_installed')
    expect(JSON.parse(await readFile(f.settings('X'), 'utf8')).statusLine).toBeUndefined()
    await writeFile(f.settings('X'), JSON.stringify(user))
    expect((await (await f.start('X')).done()).state).toBe('installed')
    expect((await (await f.start('X', 'reset')).done()).state).toBe('not_installed')
    expect(JSON.parse(await readFile(f.settings('X'), 'utf8')).statusLine).toEqual(user.statusLine)
    await writeFile(f.settings('X'), '{}')
    expect((await (await f.start('X')).done()).state).toBe('installed')
    const retiring = await f.start('X', 'retire', 'retired')
    await retiring.wait('retired')
    expect((await (await f.start('X')).done()).state).toBe('error')
    retiring.child.send('continue')
    expect((await retiring.done()).state).toBe('installed')
    expect((await (await f.start('X')).done()).state).toBe('installed')
    expect(JSON.parse(await readFile(f.settings('X'), 'utf8')).statusLine).toBeDefined()
  }
)

it.skipIf(process.platform === 'win32')(
  'cleans actual abandoned owner records with O(L) probes and two cleanup chains without listing unrelated names',
  async () => {
    const rows: { population: number; metrics: Record<string, unknown> }[] = []
    for (const population of [6, 60]) {
      const f = await fixture()
      const creator = await f.start('unused', 'residues', String(population))
      expect((await creator.done()).state).toBe('residues')
      for (let index = 0; index < 1000; index++) {
        await writeFile(join(f.home, '.orca', `unrelated-${index}`), '')
      }
      const next = await f.start('X')
      expect((await next.done()).state).toBe('installed')
      const metrics = await next.metrics()
      if (!isPlainObject(metrics)) {
        throw new Error('Missing cleanup counters')
      }
      expect(metrics.cleanupNames).toBe(population)
      expect(metrics.rootListings).toBe(0)
      expect(metrics.maxProbes).toBeLessThanOrEqual(2)
      expect(metrics.probes).toBe(process.platform === 'darwin' ? population + 2 : 0)
      rows.push({ population, metrics })
    }
    console.log('SL_SCOPED_CLEANUP', JSON.stringify(rows))
  },
  30_000
)
