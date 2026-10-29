import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from './runtime-mobile-notification-controller'

it('holds the saved forwarding environment across restart, applies reads without publication, and releases on quiet expiry', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'orca-forwarded-read-'))
  vi.useFakeTimers()
  const first = new RuntimeMobileNotificationController()
  const restarted = new RuntimeMobileNotificationController()
  try {
    first.configureDismissalStore(folder)
    const structuredOrigin = {
      scope: {
        executionHostId: 'local' as const,
        wslDistro: null,
        workspaceId: 'B-workspace',
        workspaceKind: 'folder' as const
      },
      sessionId: 'session',
      cause: { kind: 'prompt' as const, promptId: 'prompt' },
      journalCursor: { epoch: 'B-journal', sequence: 4 }
    }
    const alert = {
      type: 'notification' as const,
      source: 'agent-task-complete' as const,
      title: 'Orca',
      body: '',
      notificationId: 'prompt',
      structuredOrigin,
      forwardingEnvironmentId: 'A-environment-for-B'
    }
    first.dispatch(alert)
    await first.closeDismissals()
    restarted.configureDismissalStore(folder)
    expect(restarted.getForwardedEnvironments()).toEqual(['A-environment-for-B'])
    const events: MobileNotificationEvent[] = []
    restarted.onDispatched((event) => events.push(event))
    restarted.retireStructuredAttention({
      sessionId: 'session',
      observedCursor: structuredOrigin.journalCursor
    })
    expect(events.map((event) => event.type)).toEqual(['dismiss'])
    expect(restarted.getForwardedEnvironments()).toEqual([])
    restarted.dispatch({ ...alert, notificationId: 'next' })
    const changes: string[][] = []
    restarted.onForwardedEnvironmentsChanged((environments) => changes.push(environments))
    await restarted.flushDismissals()
    await vi.advanceTimersByTimeAsync(7 * 86400_000)
    expect(changes).toEqual([[]])
    expect(restarted.getForwardedEnvironments()).toEqual([])
  } finally {
    await first.closeDismissals()
    await restarted.closeDismissals()
    vi.useRealTimers()
    rmSync(folder, { recursive: true, force: true })
  }
})

it.each([10, 100])(
  'does no projection for unrelated events and one for %s settled deliveries',
  async (count) => {
    const folder = mkdtempSync(join(tmpdir(), 'orca-forwarded-perf-'))
    const controller = new RuntimeMobileNotificationController()
    const project = vi.spyOn(MobileNotificationDismissalStore.prototype, 'forwardedEnvironments')
    const structuredOrigin = {
      scope: {
        executionHostId: 'local' as const,
        wslDistro: null,
        workspaceId: 'B',
        workspaceKind: 'folder' as const
      },
      sessionId: 'session',
      cause: { kind: 'prompt' as const, promptId: 'prompt' },
      journalCursor: { epoch: 'journal', sequence: 4 }
    }
    try {
      controller.configureDismissalStore(folder)
      for (let i = 0; i < count; i++)
        controller.dispatch({
          type: 'notification',
          source: 'agent-task-complete',
          title: 'Orca',
          body: '',
          notificationId: `prompt-${i}`,
          forwardingEnvironmentId: `environment-${i}`,
          structuredOrigin
        })
      project.mockClear()
      for (let i = 0; i < count; i++)
        controller.dispatch({ type: 'notification', source: 'plugin', title: 'Orca', body: '' })
      expect(project).not.toHaveBeenCalled()
      controller.retireStructuredAttention({
        sessionId: 'session',
        observedCursor: { epoch: 'journal', sequence: 4 }
      })
      expect(project).toHaveBeenCalledTimes(1)
      expect(controller.getForwardedEnvironments()).toEqual([])
      project.mockClear()
      controller.retireStructuredAttention({
        sessionId: 'session',
        observedCursor: { epoch: 'journal', sequence: 4 }
      })
      expect(project).not.toHaveBeenCalled()
    } finally {
      await controller.closeDismissals()
      project.mockRestore()
      rmSync(folder, { recursive: true, force: true })
    }
  }
)

it('releases forwarded interest when an ordinary record evicts its last delivery', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'orca-forwarded-evict-'))
  const controller = new RuntimeMobileNotificationController()
  try {
    controller.configureDismissalStore(folder)
    controller.dispatch({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'Orca',
      body: '',
      notificationId: 'forwarded',
      forwardingEnvironmentId: 'B',
      structuredOrigin: {
        scope: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'B',
          workspaceKind: 'folder'
        },
        sessionId: 'session',
        cause: { kind: 'prompt', promptId: 'prompt' },
        journalCursor: { epoch: 'journal', sequence: 4 }
      }
    })
    const changes: string[][] = []
    controller.onForwardedEnvironmentsChanged((ids) => changes.push(ids))
    for (let i = 0; i < 4096; i++)
      controller.dispatch({
        type: 'notification',
        source: 'terminal-bell',
        title: 'Orca',
        body: '',
        notificationId: `ordinary-${i}`
      })
    expect(changes).toEqual([[]])
  } finally {
    await controller.closeDismissals()
    rmSync(folder, { recursive: true, force: true })
  }
})
