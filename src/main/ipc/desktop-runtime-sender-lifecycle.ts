import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { abortWhenRendererGone, type RendererLifetimeSender } from './renderer-lifetime-abort'

type DesktopRuntimeSender = RendererLifetimeSender & { readonly id: number }

type SenderState = {
  connectionId: string
  sender: DesktopRuntimeSender
  subscriptions: Map<string, AbortController>
  lifetime: ReturnType<typeof abortWhenRendererGone>
}

type CleanupRuntime = Pick<OrcaRuntimeService, 'cleanupSubscriptionsForConnection'>

export class DesktopRuntimeSenderLifecycle {
  private readonly senders = new Map<number, SenderState>()
  private nextConnectionGeneration = 1

  constructor(private readonly runtime: CleanupRuntime) {}

  connectionIdFor(sender: DesktopRuntimeSender): string {
    return this.stateFor(sender).connectionId
  }

  subscriptionsFor(sender: DesktopRuntimeSender): Map<string, AbortController> {
    return this.stateFor(sender).subscriptions
  }

  existingSubscriptionsFor(sender: DesktopRuntimeSender): Map<string, AbortController> | null {
    const state = this.senders.get(sender.id)
    return state?.sender === sender ? state.subscriptions : null
  }

  private stateFor(sender: DesktopRuntimeSender): SenderState {
    const existing = this.senders.get(sender.id)
    if (existing?.sender === sender) {
      return existing
    }
    if (existing) {
      this.retire(existing)
    }
    const state: SenderState = {
      connectionId: this.mintConnectionId(sender.id),
      sender,
      subscriptions: new Map(),
      lifetime: abortWhenRendererGone(sender)
    }
    this.senders.set(sender.id, state)
    state.lifetime.signal.addEventListener('abort', () => this.retire(state), { once: true })
    return state
  }

  private retire(state: SenderState): void {
    if (this.senders.get(state.sender.id) !== state) {
      return
    }
    const retiredConnectionId = state.connectionId
    this.senders.delete(state.sender.id)
    state.lifetime.dispose()
    for (const controller of state.subscriptions.values()) {
      controller.abort()
    }
    state.subscriptions.clear()
    this.runtime.cleanupSubscriptionsForConnection(retiredConnectionId)
  }

  private mintConnectionId(senderId: number): string {
    return `desktop-renderer:${senderId}:${this.nextConnectionGeneration++}`
  }
}
