import { afterEach, describe, expect, it } from 'vitest'
import {
  beginWslMoveUndoRun,
  claimWslMoveRun,
  isAnyWslMoveRunning,
  releaseWslMoveRun,
  type RunningWslMove
} from '../persistence/moving-wsl-projects/wsl-move-running-moves'
import { wslMoveInstallHold } from './updater-wsl-move-install-hold'

const ends: (() => void)[] = []
let move: RunningWslMove | null = null

afterEach(() => {
  ends.splice(0).forEach((end) => end())
  if (move) {
    releaseWslMoveRun('Ubuntu', move)
    move = null
  }
})

function beginUndo(): () => void {
  const end = beginWslMoveUndoRun()
  ends.push(end)
  return end
}

describe('wslMoveInstallHold', () => {
  it('lets an install through when nothing moves or comes back', () => {
    expect(wslMoveInstallHold()).toBeNull()
  })

  it('holds for an undo, with its own message, without counting it as a move', () => {
    beginUndo()
    expect(wslMoveInstallHold()).toEqual({
      lifecycleEvent: 'quit_and_install_held_for_wsl_move_undo',
      message: 'A project is coming back from its WSL host. Install the update once that finishes.'
    })
    // The driver, the quit prompt and Cancel read this; an undo must not look like a move to them.
    expect(isAnyWslMoveRunning()).toBe(false)
    move = claimWslMoveRun('Ubuntu')
    expect(move).not.toBeNull()
  })

  it('names the move when a move and an undo both run', () => {
    beginUndo()
    move = claimWslMoveRun('Ubuntu')
    expect(wslMoveInstallHold()?.lifecycleEvent).toBe('quit_and_install_held_for_wsl_move')
  })

  it('holds until every undo has ended, and an end counts once', () => {
    const first = beginUndo()
    const second = beginUndo()
    first()
    first()
    expect(wslMoveInstallHold()).not.toBeNull()
    second()
    expect(wslMoveInstallHold()).toBeNull()
  })
})
