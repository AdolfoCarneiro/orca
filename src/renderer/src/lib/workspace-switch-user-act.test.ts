import { beforeEach, describe, expect, it, vi } from 'vitest'
import { markVisited } from './worktree-activation-visit'
import {
  lastUserWorkspaceSwitchAt,
  noteUserWorkspaceSwitch,
  resetWorkspaceSwitchUserActsForTests,
  takeWorkspaceSwitchWake
} from './workspace-switch-user-act'

describe("the user's switch to a workspace (E9)", () => {
  beforeEach(() => resetWorkspaceSwitchUserActsForTests())

  it('is recorded when the user opens the workspace, and not before', () => {
    expect(lastUserWorkspaceSwitchAt('wt-1')).toBeUndefined()
    markVisited(
      {
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null,
        markWorktreeVisited: vi.fn()
      },
      'wt-1',
      { worktreeId: null, hostId: null }
    )
    expect(lastUserWorkspaceSwitchAt('wt-1')).toEqual(expect.any(Number))
    expect(lastUserWorkspaceSwitchAt('wt-2')).toBeUndefined()
  })

  it('wakes each consumer once per switch; a remount with no new switch does not', () => {
    noteUserWorkspaceSwitch('wt-1')
    expect(takeWorkspaceSwitchWake('wt-1', 'explorer')).toBe(true)
    expect(takeWorkspaceSwitchWake('wt-1', 'explorer')).toBe(false)
    expect(takeWorkspaceSwitchWake('wt-1', 'git-status')).toBe(true)
    noteUserWorkspaceSwitch('wt-1')
    expect(takeWorkspaceSwitchWake('wt-1', 'explorer')).toBe(true)
    expect(takeWorkspaceSwitchWake('wt-2', 'explorer')).toBe(false)
  })
})
