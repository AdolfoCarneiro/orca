import { beforeEach, expect, it, vi } from 'vitest'
import type * as WorktreeMetaPersistModule from '@/store/slices/worktrees/metadata/worktree-meta-persist'
import {
  addLiveTerminalTab,
  createAttentionStore,
  installAttentionMockApi,
  screenOf,
  WS_A
} from '@/store/slices/workspace-attention/workspace-unread-characterization-fixture'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('@/store/slices/worktrees/metadata/worktree-meta-persist', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeMetaPersistModule>()
  return { ...actual, persistWorktreeMeta: vi.fn(async () => undefined) }
})

beforeEach(() => {
  vi.clearAllMocks()
  installAttentionMockApi()
})

it('counts a worker tab created in another workspace only once a present user is on it', async () => {
  const reportWorkerTouch = vi.fn(async () => ({ changed: 1 }))
  const { store } = createAttentionStore({ desktopAway: true, reportWorkerTouch })
  // The only tab of a new worktree is its selected tab, while the user stays on WS_B.
  const worker = addLiveTerminalTab(store, WS_A, 'worker-tab')
  expect(reportWorkerTouch).not.toHaveBeenCalled()

  store.getState().setActiveWorktree(WS_A)
  await Promise.resolve()
  expect(reportWorkerTouch).not.toHaveBeenCalled()

  screenOf(store).input()
  expect(reportWorkerTouch).toHaveBeenCalledTimes(1)
  expect(reportWorkerTouch).toHaveBeenCalledWith({
    subject: { paneKey: worker.paneKey },
    target: { kind: 'local' }
  })
})
