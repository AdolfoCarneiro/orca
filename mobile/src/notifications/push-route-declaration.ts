import type { MobilePushToken } from './push-token'
import { buildPushRouteDeclaration } from './push-route-declaration-build'
export { mobilePushRouteKey } from './push-route-declaration-build'

const GATEWAY_ORIGIN = process.env.EXPO_PUBLIC_PUSH_GATEWAY_ORIGIN ?? 'https://push.onorca.dev'
type Desired = { token: MobilePushToken; intent: number }
type Wake = 'input' | 'catalog' | 'renewal' | 'registration'
type Publication = {
  body: string
  generation: number
  acknowledged: boolean
  sending: boolean
  attempt: number
}
export type PushRoutePublication = {
  wake(reason: Wake): void
  registered(gatewayOrigin?: string): void
  stop(): void
}
let attached: PushRoutePublication | undefined

export function refreshPushRoutes(): void {
  attached?.wake('catalog')
}

export function startPushRoutePublication(
  readDesired: () => Desired | undefined
): PushRoutePublication {
  attached?.stop()
  let active = true
  let identity: string | undefined
  let generation = 0
  let enrolled = false
  let wakeSerial = 0
  let due = false
  let publication: Publication | undefined
  let transportTimer: ReturnType<typeof setTimeout> | undefined
  let build:
    | {
        generation: number
        remaining: number
        running: boolean
        pendingWake: boolean
        timer?: ReturnType<typeof setTimeout>
      }
    | undefined
  const currentIdentity = () => JSON.stringify(readDesired())
  const valid = (candidate: number) =>
    active &&
    candidate === generation &&
    identity === currentIdentity() &&
    readDesired() !== undefined
  function clearTransport() {
    clearTimeout(transportTimer)
    transportTimer = undefined
  }
  function retire() {
    generation++
    clearTimeout(build?.timer)
    clearTransport()
    build = undefined
    publication = undefined
    due = false
  }
  async function send(current: Publication): Promise<void> {
    if (!valid(current.generation) || current.acknowledged || current.sending) {
      return
    }
    clearTransport()
    current.sending = true
    const wake = wakeSerial
    let status: number | undefined
    try {
      const response = await fetch(`${GATEWAY_ORIGIN}/v1/routes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        body: current.body
      })
      status = response.status
      if (valid(current.generation) && response.ok) {
        current.acknowledged = true
      }
    } catch {}
    current.sending = false
    if (!valid(current.generation)) {
      return
    }
    if (current.acknowledged) {
      if (due) {
        due = false
        startBuild()
      }
      return
    }
    const permanent = status !== undefined && status >= 400 && status < 500 && status !== 429
    if (permanent && (status !== 400 || current.attempt > 0) && wake === wakeSerial) {
      due = false
      return
    }
    const delay =
      wake !== wakeSerial ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(current.attempt, 6))
    current.attempt++
    transportTimer = setTimeout(() => {
      void send(current)
    }, delay)
  }
  function startBuild() {
    clearTimeout(build?.timer)
    clearTransport()
    publication = undefined
    const slot = { generation: ++generation, remaining: 2, running: false, pendingWake: false }
    build = slot
    void attemptBuild(slot)
  }
  async function attemptBuild(slot: NonNullable<typeof build>): Promise<void> {
    const desired = readDesired()
    if (!desired || !valid(slot.generation) || slot.running) {
      return
    }
    slot.running = true
    try {
      const body = await buildPushRouteDeclaration(desired.token, enrolled, () =>
        valid(slot.generation)
      )
      if (!valid(slot.generation)) {
        return
      }
      if (body) {
        publication = {
          body,
          generation: slot.generation,
          acknowledged: false,
          sending: false,
          attempt: 0
        }
        build = undefined
        void send(publication)
      } else if (slot.pendingWake) {
        startBuild()
      }
    } catch {
      if (!valid(slot.generation)) {
        return
      }
      if (slot.remaining > 0) {
        slot.remaining--
        slot.timer = setTimeout(() => {
          slot.timer = undefined
          void attemptBuild(slot)
        }, 5000)
      } else if (slot.pendingWake) {
        slot.pendingWake = false
        startBuild()
      }
    } finally {
      slot.running = false
    }
  }
  const handle: PushRoutePublication = {
    wake(reason: Wake): void {
      if (!active) {
        return
      }
      const desired = readDesired()
      const next = currentIdentity()
      if (!desired) {
        retire()
        identity = undefined
        return
      }
      if (identity !== next || reason === 'catalog') {
        retire()
        identity = next
        startBuild()
        return
      }
      if (reason === 'input') {
        return
      }
      if (reason === 'registration' || reason === 'renewal') {
        wakeSerial++
      }
      if (publication) {
        if (publication.acknowledged) {
          if (reason === 'renewal') {
            startBuild()
          }
        } else if (reason === 'renewal') {
          if (!publication.sending && !transportTimer) {
            startBuild()
          } else {
            due = true
          }
        } else if (!publication.sending) {
          publication.attempt = 0
          void send(publication)
        }
      } else if (build?.running || build?.timer) {
        build.pendingWake = true
      } else {
        startBuild()
      }
    },
    registered(gatewayOrigin?: string): void {
      if (!active || !readDesired() || gatewayOrigin !== GATEWAY_ORIGIN) {
        return
      }
      enrolled = true
      handle.wake('registration')
    },
    stop(): void {
      active = false
      retire()
      if (attached === handle) {
        attached = undefined
      }
    }
  }
  attached = handle
  return handle
}
