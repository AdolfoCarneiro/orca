import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type * as WorkerProcessModule from '../worker-thread-child-process/worker-thread-child-process'
import { expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('../worker-thread-child-process/worker-thread-child-process', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkerProcessModule>()),
  forkProcessOnWorkerThread: bridge.fork
}))
vi.mock('@orca/process-host/fork-process', () => ({
  forkProcess: () => {
    throw new Error('fork reached the calling thread')
  }
}))

it('keeps the calling loop responsive during a blocked Windows fork and releases capacity only on physical exit', async () => {
  vi.resetModules()
  const { WorkerThreadChildProcessHost } =
    await import('../worker-thread-child-process/worker-thread-child-process')
  const { FilesystemHostSupervisor } = await import('./filesystem-host-supervisor')
  const directory = await mkdtemp(join(tmpdir(), 'orca-fs-worker-launch-'))
  const entryPath = join(directory, 'child.cjs')
  await writeFile(
    entryPath,
    `
    const { randomUUID } = require('node:crypto');
    process.send({type:'ready', protocolVersion:1, workerId:randomUUID()});
    process.on('message', message => process.send({type:'result', requestId:message.requestId, ok:true,
      result:{kind:'canonicalize-path', canonicalPath:message.operation.path}}));
    process.on('disconnect', () => process.exit(0));
  `
  )
  const control = new Int32Array(new SharedArrayBuffer(4))
  const require = createRequire(import.meta.url)
  const worker = new Worker(
    `
    require(${JSON.stringify(require.resolve('tsx/cjs'))});
    const { parentPort, workerData } = require('node:worker_threads');
    const childProcess = require('node:child_process');
    const fork = childProcess.fork;
    childProcess.fork = (...args) => {
      parentPort.postMessage({type:'fork-entered'});
      Atomics.wait(new Int32Array(workerData), 0, 0);
      return fork(...args);
    };
    require(${JSON.stringify(join(__dirname, '../worker-thread-child-process/worker-thread-child-process-server.ts'))})
      .serveWorkerThreadChildProcesses(parentPort);
  `,
    { eval: true, workerData: control.buffer, execArgv: ['--conditions=orca-source'] }
  )
  const entered = new Promise<void>((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.type === 'fork-entered') {
        resolve()
      }
    })
    worker.once('error', reject)
  })
  const host = new WorkerThreadChildProcessHost(() => worker)
  bridge.fork.mockImplementation((spec) => host.fork(spec))
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const supervisor = new FilesystemHostSupervisor({ entryPath, maximumChildren: 2 })
  try {
    const pending = supervisor.dispatch({
      operationId: 'worker-launch',
      operation: { kind: 'canonicalize-path', path: 'C:\\repo' },
      executionHost: 'native',
      storageClass: 'workspace',
      admission: 'foreground',
      deadlineMs: 5000
    })
    await Promise.race([
      entered,
      pending.then(() => {
        throw new Error('child ran before fork gate')
      })
    ])
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(supervisor.health().physicalChildren).toBe(1)
    expect(bridge.fork).toHaveBeenCalledOnce()
    Atomics.store(control, 0, 1)
    Atomics.notify(control, 0)
    await expect(pending).resolves.toMatchObject({ canonicalPath: 'C:\\repo' })
    expect(supervisor.health().physicalChildren).toBe(1)
    await supervisor.dispose()
    expect(supervisor.health().physicalChildren).toBe(0)
  } finally {
    Atomics.store(control, 0, 1)
    Atomics.notify(control, 0)
    platform.mockRestore()
    await supervisor.dispose()
    await worker.terminate()
    await rm(directory, { recursive: true, force: true })
  }
})

it('fails closed without a calling-thread fallback when the Windows worker is unavailable', async () => {
  vi.resetModules()
  const { WorkerThreadChildProcessHost } =
    await import('../worker-thread-child-process/worker-thread-child-process')
  const { FilesystemHostSupervisor } = await import('./filesystem-host-supervisor')
  const host = new WorkerThreadChildProcessHost(() => {
    throw new Error('worker entry missing')
  })
  bridge.fork.mockImplementation((spec) => host.fork(spec))
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const supervisor = new FilesystemHostSupervisor({ entryPath: 'unused', maximumChildren: 2 })
  try {
    await expect(
      supervisor.dispatch({
        operationId: 'unavailable-worker',
        operation: { kind: 'canonicalize-path', path: 'C:\\repo' },
        executionHost: 'native',
        storageClass: 'workspace',
        admission: 'foreground',
        deadlineMs: 1000
      })
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(supervisor.health().physicalChildren).toBe(0)
  } finally {
    platform.mockRestore()
    await supervisor.dispose()
  }
})
