import { expect, it, vi } from 'vitest'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from '../daemon/daemon-session-scrollback-window'
import { AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from './orca-runtime-postlude'
import { createHydrationRuntime, PTY_ID, SIZE } from './headless-hydration-ownership-test-fixture'

it('retains only the configured scrollback depth', async () => {
  const runtime = createHydrationRuntime({
    headlessTerminalScrollbackRows: DAEMON_SESSION_SCROLLBACK_ROWS
  })
  const lines = Array.from({ length: 3000 }, (_, i) => `L${String(i + 1).padStart(4, '0')}`)
  runtime.onPtyData(PTY_ID, lines.join('\r\n'), 1)
  await runtime.model().writeChain
  const snapshot = await runtime.serializeMainTerminalBuffer(PTY_ID, { scrollbackRows: 5000 })
  const retained = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`.match(/L\d{4}/g)
  expect(retained).toHaveLength(DAEMON_SESSION_SCROLLBACK_ROWS + SIZE.rows)
  expect(retained?.at(-1)).toBe('L3000')
})

it('releases live bytes queued behind a provider seed that never answers', async () => {
  vi.useFakeTimers()
  try {
    const runtime = createHydrationRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => SIZE,
      serializeProviderBuffer: () => new Promise(() => {})
    })
    runtime.replaceExecutionContext()
    runtime.onPtyData(PTY_ID, 'LIVE-AFTER-SEED', 1)
    await vi.advanceTimersByTimeAsync(AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS)
    await runtime.model().writeChain
    expect(runtime.model().emulator.getVisibleLines().join('\n')).toContain('LIVE-AFTER-SEED')
    expect(runtime.retainedState().providerPreferred).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})
