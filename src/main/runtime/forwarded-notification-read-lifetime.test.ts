import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
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
