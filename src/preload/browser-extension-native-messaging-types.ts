export type Listener = (...args: unknown[]) => unknown

export type State = {
  // 'starting' until main confirms the host runs; posts wait for it.
  state: 'starting' | 'open' | 'closed'
  queued: { json: string; bytes: number }[]
  queuedBytes: number
  draining: boolean
  onMessage: Set<Listener>
  onDisconnect: Set<Listener>
  port: Record<string, unknown>
}

export type EndPort = (id: string, entry: State, error?: string, closeMain?: boolean) => void
