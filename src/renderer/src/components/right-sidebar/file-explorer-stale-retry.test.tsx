// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'
import {
  noteUserWorkspaceSwitch,
  resetWorkspaceSwitchUserActsForTests,
  WORKSPACE_SWITCH_MOUNT_WINDOW_MS
} from '@/lib/workspace-switch-user-act'

afterEach(() => {
  cleanup()
  resetWorkspaceSwitchUserActsForTests()
})
function params() {
  return {
    props: {
      workspaceKey: 'repo-1::/repo',
      activeWorktreeId: 'repo-1::/repo',
      visibleFilesWorktreePath: '/repo',
      expanded: new Set<string>(),
      dirCache: {},
      loadingDirPaths: new Set<string>(),
      rootError: null,
      invalidateTree: vi.fn(),
      retireView: vi.fn(),
      reconcileView: vi.fn(),
      loadRevision: 0,
      resetAndLoad: vi.fn(),
      resetSelection: vi.fn(),
      setNameFilterQuery: vi.fn()
    }
  }
}
it("only the user's own switch to a workspace lets its open read start a stopped WSL distro", () => {
  const { props } = params()
  noteUserWorkspaceSwitch(props.workspaceKey)
  renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
  expect(props.resetAndLoad).toHaveBeenCalledExactlyOnceWith({ wakeWslDistro: true })
})
it('an old switch no consumer used is not redeemed by a later mount (E9)', () => {
  vi.useFakeTimers()
  try {
    const { props } = params()
    // The user switched here with the sidebar closed; the explorer mounts long after.
    noteUserWorkspaceSwitch(props.workspaceKey)
    vi.advanceTimersByTime(WORKSPACE_SWITCH_MOUNT_WINDOW_MS + 1)
    renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
    expect(props.resetAndLoad).toHaveBeenCalledExactlyOnceWith(undefined)
  } finally {
    vi.useRealTimers()
  }
})
it('a restore, remount or re-open with no new switch never wakes WSL', () => {
  const { props } = params()
  renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
  expect(props.resetAndLoad).toHaveBeenCalledExactlyOnceWith(undefined)

  noteUserWorkspaceSwitch(props.workspaceKey)
  const first = renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
  first.unmount()
  const remount = renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
  expect(props.resetAndLoad).toHaveBeenNthCalledWith(2, { wakeWslDistro: true })
  expect(props.resetAndLoad).toHaveBeenNthCalledWith(3, undefined)
  remount.unmount()
})
