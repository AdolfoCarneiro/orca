import { OrcaRuntimeWithBindPtyIncarnationHandle } from '../identity/terminal-handle-bindings'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult
} from '../../terminal-wait-results'
import type { AgentStatus } from '../../../../shared/agent-detection'
import { detectExplicitIdleStatusFromTitle } from '../../terminal-wait-detection'
import { buildTerminalWaitText } from '../../terminal-wait-tail-state'
import {
  evaluateTuiIdle,
  isTuiIdleReadyVerdict,
  type TuiIdleVerdict
} from '../../tui-idle-evidence'
import { ptyTuiIdleEvidence } from '../../tui-idle-evidence-source'
import { TUI_IDLE_QUIESCENCE_MS } from '../../orca-runtime-postlude'
import { USER_INPUT_HOLD_CAP_MS } from '../../claude-open-dialog-hold'
import { detectTerminalComposerDraft } from '../../../../shared/terminal-composer-draft'
import { isMailboxTerminalTakingInput } from '../../orchestration/mailbox-owner'

import type { OrcaRuntimeWithResolveWaiter } from '../../orca-runtime-resolve-waiter'

const DIALOG_HOLD_RECHECK_MS = 2000

export abstract class OrcaRuntimeWithResolveExitWaiters extends OrcaRuntimeWithBindPtyIncarnationHandle {
  protected abstract resolveWaiter(
    ...args: Parameters<OrcaRuntimeWithResolveWaiter['resolveWaiter']>
  ): ReturnType<OrcaRuntimeWithResolveWaiter['resolveWaiter']>

  protected abstract removeWaiter(
    ...args: Parameters<OrcaRuntimeWithResolveWaiter['removeWaiter']>
  ): ReturnType<OrcaRuntimeWithResolveWaiter['removeWaiter']>

  protected resolvePtyExitWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    for (const waiter of this.terminalWaiters.forPty(ptyId)) {
      if (waiter.condition === 'exit') {
        this.resolveWaiter(waiter, buildPtyTerminalWaitResult(waiter.handle, 'exit', pty))
      } else {
        // Why: after exit, conditions like tui-idle can never be satisfied — reject now instead of spinning the poll until timeout on a dead process.
        this.removeWaiter(waiter)
        waiter.reject(new Error('terminal_exited'))
      }
    }
  }

  protected resolvePtyTuiIdleWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    const waiters = this.terminalWaiters
      .forPty(ptyId)
      .filter((waiter) => waiter.condition === 'tui-idle')
    if (waiters.length === 0) {
      return
    }
    // Re-rank titles: weak readiness cannot see tail-truncated dialogs and must wait for a rendered-screen poll.
    const verdict = this.evaluateTuiIdleForPty(pty)
    for (const waiter of waiters) {
      if (verdict.kind === 'blocked') {
        this.resolveWaiter(
          waiter,
          buildPtyTerminalWaitBlockedResult(waiter.handle, 'tui-idle', pty, verdict.reason)
        )
      } else if (verdict.kind === 'ready-strong') {
        this.resolveWaiter(waiter, buildPtyTerminalWaitResult(waiter.handle, 'tui-idle', pty))
      }
    }
  }

  /** Point a terminal at its mail once it takes input and is settled; refusal re-arms the recheck. */
  protected deliverPendingMessagesForPty(ptyId: string): void {
    const terminal = this.getOrchestrationMailboxTerminal(ptyId)
    if (
      terminal &&
      isMailboxTerminalTakingInput(terminal) &&
      this.checkDeliverySettledAndArmRecheck(ptyId)
    ) {
      this.orchestrationMailboxNotifications.deliverForTerminal(terminal)
    }
  }

  /** Edge-driven delivery needs a one-shot recheck when quiet evidence may later settle; otherwise hookless agents can strand queued mail without another title/graph/message edge. */
  protected checkDeliverySettledAndArmRecheck(ptyId: string): boolean {
    if (this.isAgentSettledForDelivery(ptyId)) {
      this.clearDeliveryRecheck(ptyId)
      return true
    }
    this.armDeliveryRecheck(ptyId)
    return false
  }

  protected clearDeliveryRecheck(ptyId: string): void {
    const timer = this.deliveryRecheckTimersByPtyId.get(ptyId)
    if (timer) {
      clearTimeout(timer)
      this.deliveryRecheckTimersByPtyId.delete(ptyId)
    }
  }

  private armDeliveryRecheck(ptyId: string): void {
    if (this.deliveryRecheckTimersByPtyId.has(ptyId)) {
      return
    }
    const pty = this.ptysById.get(ptyId)
    // Only quiet-window refusal expires with time; schedule just beyond it and re-arm from fresher output if still streaming.
    const elapsed = pty?.lastOutputAt ? Date.now() - pty.lastOutputAt : 0
    // A dialog or draft lifts only when the user acts, so poll it slowly rather than at 20 Hz.
    const delay = this.isPtyHoldingDelivery(ptyId)
      ? DIALOG_HOLD_RECHECK_MS
      : Math.max(TUI_IDLE_QUIESCENCE_MS - elapsed, 0) + 50
    const timer = setTimeout(() => {
      this.deliveryRecheckTimersByPtyId.delete(ptyId)
      // Delivery rechecks settlement first; the agent may have become busy again.
      this.deliverPendingMessagesForPty(ptyId)
    }, delay)
    timer.unref?.()
    this.deliveryRecheckTimersByPtyId.set(ptyId, timer)
  }

  /** Pointer plus Enter takes the waits' readiness ranking, plus a working verdict: agents queue or
   *  steer text sent mid-turn, so only dialogs, drafts and unsettled terminals hold mail. Callers
   *  separately require live status evidence. */
  protected isAgentSettledForDelivery(ptyId: string): boolean {
    const pty = this.ptysById.get(ptyId)
    if (!pty || this.isPtyHoldingDelivery(ptyId)) {
      return false
    }
    const evidence = ptyTuiIdleEvidence(this.tuiIdleEvidenceSource, pty, () =>
      buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
    )
    // Why no blocked reader: a refusal here re-arms a recheck that a lingering tail prompt
    // would spin, so delivery keeps its own, blocked-blind, reading of the same ranking.
    const verdict = evaluateTuiIdle({ ...evidence, readTailBlockedReason: () => null })
    // The ranking vetoes overlays only on ready verdicts; an overlay refuses input mid-turn too.
    return verdict.kind === 'working'
      ? evidence.readScreenInputVeto() !== true
      : isTuiIdleReadyVerdict(verdict)
  }

  /** An unsent draft would be submitted with the injected text; the cap bounds an abandoned or misread one. */
  private isPtyHoldingDelivery(ptyId: string): boolean {
    if (this.isPtyAwaitingUserInput(ptyId)) {
      return true
    }
    const lastInputAt = this.terminalRunFacts.readLastDrivingInputAt(ptyId)
    const state = this.readWholeScreenModel(ptyId)
    return (
      lastInputAt !== null &&
      Date.now() - lastInputAt <= USER_INPUT_HOLD_CAP_MS &&
      !!state &&
      detectTerminalComposerDraft(state.emulator.getCursorLineContext()) !== null
    )
  }

  protected evaluateTuiIdleForPty(pty: RuntimePtyWorktreeRecord): TuiIdleVerdict {
    return evaluateTuiIdle(
      ptyTuiIdleEvidence(this.tuiIdleEvidenceSource, pty, () =>
        buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
      )
    )
  }

  protected getAdoptedPtyExplicitIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null {
    const title = pty.lastOscTitle ?? this.getAdoptedPtyTitle(pty)
    return title ? detectExplicitIdleStatusFromTitle(title) : null
  }

  protected getAdoptedPtyTitle(pty: RuntimePtyWorktreeRecord): string | null {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId !== pty.ptyId) {
        continue
      }
      const title = leaf.paneTitle ?? this.tabs.get(leaf.tabId)?.title
      if (!title) {
        continue
      }
      return title
    }
    return null
  }
}
