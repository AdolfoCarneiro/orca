import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { runtimeWithLeaf } from './orca-runtime-pty-leaf.test-fixture'
import { evaluateTuiIdle } from './tui-idle-evidence'
import { leafTuiIdleEvidence, ptyTuiIdleEvidence } from './tui-idle-evidence-source'

const PTY_ID = 'repo-1::/tmp/wt@@1a2b3c4d'
const CODEX_COMPOSER = '› Ask Codex to do anything'

afterEach(() => {
  vi.useRealTimers()
})

it('a silent reattached Codex reads quiet on its PTY and its pane leaf alike, and stays quiet when its pane mounts', () => {
  vi.useFakeTimers({ now: 100_000 })
  const { runtime, leaf } = runtimeWithLeaf(PTY_ID)
  runtime.seedTerminalRestoreTail(PTY_ID, { text: CODEX_COMPOSER })
  runtime.startReattachedOutputClock(PTY_ID)
  const pty = runtime['ptysById'].get(PTY_ID)!
  const source = {
    ...runtime['tuiIdleEvidenceSource'],
    getPaneAgent: () => 'codex' as const,
    readScreenLines: () => [CODEX_COMPOSER],
    readRuledScreen: () => ({ lines: [CODEX_COMPOSER], alternateScreen: false })
  }
  const verdicts = () =>
    [
      evaluateTuiIdle(ptyTuiIdleEvidence(source, pty, () => pty.preview)),
      evaluateTuiIdle(leafTuiIdleEvidence(source, leaf, () => leaf.preview))
    ].map((verdict) => verdict.kind)

  expect(verdicts()).toEqual(['pending', 'pending'])
  vi.advanceTimersByTime(source.quiescenceMs)
  // Neither record ever saw output; the clock is main's observation since the reattach.
  expect([pty.lastOutputAt, leaf.lastOutputAt]).toEqual([null, null])
  expect(verdicts()).toEqual(['ready-strong', 'ready-strong'])
  // A pane mounting later reattaches the same process; its observed quiet must not restart.
  runtime.startReattachedOutputClock(PTY_ID)
  expect(verdicts()).toEqual(['ready-strong', 'ready-strong'])
})
