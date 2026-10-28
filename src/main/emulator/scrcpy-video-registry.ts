import type { ScrcpyVideoMeta } from './android/scrcpy-video-frame-parser'

// Cache metadata, decoder config, and the current GOP for late subscribers.

const MAX_GOP_FRAMES = 120

export type ScrcpyVideoFrameMessage = {
  config: boolean
  keyFrame: boolean
  pts: string
  bytes: ArrayBuffer
}

export type ScrcpyVideoEvent =
  | { type: 'meta'; meta: ScrcpyVideoMeta }
  | { type: 'frame'; frame: ScrcpyVideoFrameMessage }

export type ScrcpyVideoSubscriber = (event: ScrcpyVideoEvent) => void

type RegistryEntry = {
  meta?: ScrcpyVideoMeta
  config?: ScrcpyVideoFrameMessage
  gop: ScrcpyVideoFrameMessage[]
  subscribers: Set<ScrcpyVideoSubscriber>
  close: () => void
}

class ScrcpyVideoRegistry {
  private readonly entries = new Map<string, RegistryEntry>()

  register(deviceId: string, close: () => void): void {
    this.entries.set(deviceId, { subscribers: new Set(), gop: [], close })
  }

  pushMeta(deviceId: string, meta: ScrcpyVideoMeta): void {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      return
    }
    entry.meta = meta
    for (const subscriber of entry.subscribers) {
      subscriber({ type: 'meta', meta })
    }
  }

  pushFrame(deviceId: string, frame: ScrcpyVideoFrameMessage): void {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      return
    }
    if (frame.config) {
      entry.config = frame
    } else if (frame.keyFrame) {
      entry.gop = [frame]
    } else if (entry.gop.length > 0) {
      entry.gop.push(frame)
      // Missing deltas make the remaining replay undecodable.
      if (entry.gop.length > MAX_GOP_FRAMES) {
        entry.gop = []
      }
    }
    for (const subscriber of entry.subscribers) {
      subscriber({ type: 'frame', frame })
    }
  }

  subscribe(deviceId: string, subscriber: ScrcpyVideoSubscriber): () => void {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      return () => {}
    }
    if (entry.meta) {
      subscriber({ type: 'meta', meta: entry.meta })
    }
    if (entry.config) {
      subscriber({ type: 'frame', frame: entry.config })
    }
    for (const frame of entry.gop) {
      subscriber({ type: 'frame', frame })
    }
    let waitingForKeyframe = entry.gop.length === 0
    const deliver: ScrcpyVideoSubscriber = (event) => {
      if (event.type === 'frame' && !event.frame.config) {
        if (waitingForKeyframe && !event.frame.keyFrame) {
          return
        }
        waitingForKeyframe = false
      }
      subscriber(event)
    }
    entry.subscribers.add(deliver)
    return () => entry.subscribers.delete(deliver)
  }

  stop(deviceId: string): void {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      return
    }
    entry.close()
    entry.subscribers.clear()
    this.entries.delete(deviceId)
  }

  has(deviceId: string): boolean {
    return this.entries.has(deviceId)
  }
}

export const scrcpyVideoRegistry = new ScrcpyVideoRegistry()
