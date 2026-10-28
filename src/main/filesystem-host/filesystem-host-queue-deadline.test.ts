import { expect, it, vi } from 'vitest'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'
import { FilesystemHostBackgroundQueue } from './filesystem-host-background-queue'

it('expires queued foreground work before launch rather than granting a fresh execution budget', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const invoke = vi.fn(async (operation) => {
    await gate
    return { kind: 'canonicalize-path' as const, canonicalPath: operation.path }
  })
  const supervisor = new FilesystemHostSupervisor({
    entryPath: 'unused',
    startProcess: async (options) => ({
      invoke,
      retire: async () => {
        options.onPhysicalExit?.()
        return true
      }
    })
  })
  const dispatch = (operationId: string, deadlineMs: number) =>
    supervisor.dispatch({
      operationId,
      operation: { kind: 'canonicalize-path', path: '/repo' },
      executionHost: 'native',
      admission: 'foreground',
      storageClass: 'workspace',
      deadlineMs
    })
  const running = dispatch('running', 1000)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
  await expect(dispatch('queued', 10)).rejects.toMatchObject({ code: 'deadline' })
  release()
  await running
  expect(invoke).toHaveBeenCalledOnce()
  await supervisor.dispose()
})
it('bounds background admission before the supervisor queue', async () => {
  const queue = new FilesystemHostBackgroundQueue(1)
  let release!: () => void
  const running = queue.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const pending = Array.from({ length: 128 }, () => queue.run(async () => {}).catch(() => {}))
  await expect(queue.run(async () => {})).rejects.toThrow('queue is full')
  queue.dispose()
  release()
  await Promise.all([running, ...pending])
})
