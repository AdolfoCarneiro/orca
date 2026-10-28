import { describe, expect, it, vi } from 'vitest'
import { scrcpyVideoRegistry, type ScrcpyVideoEvent } from './scrcpy-video-registry'

function frame(config: boolean): {
  config: boolean
  keyFrame: boolean
  pts: string
  bytes: ArrayBuffer
} {
  return { config, keyFrame: !config, pts: '0', bytes: new ArrayBuffer(2) }
}

describe('scrcpyVideoRegistry', () => {
  it('replays cached meta + config to late subscribers and stops cleanly', () => {
    const close = vi.fn()
    scrcpyVideoRegistry.register('dev', close)
    scrcpyVideoRegistry.pushMeta('dev', { codecId: 'h264', width: 1, height: 2 })
    scrcpyVideoRegistry.pushFrame('dev', frame(true))

    const events: ScrcpyVideoEvent['type'][] = []
    const unsubscribe = scrcpyVideoRegistry.subscribe('dev', (event) => events.push(event.type))
    expect(events).toEqual(['meta', 'frame'])

    scrcpyVideoRegistry.pushFrame('dev', frame(false))
    expect(events).toEqual(['meta', 'frame', 'frame'])

    unsubscribe()
    scrcpyVideoRegistry.pushFrame('dev', frame(false))
    expect(events).toEqual(['meta', 'frame', 'frame'])

    scrcpyVideoRegistry.stop('dev')
    expect(close).toHaveBeenCalledTimes(1)
    expect(scrcpyVideoRegistry.has('dev')).toBe(false)
  })

  it('replays the current GOP (keyframe + following deltas) to late subscribers', () => {
    scrcpyVideoRegistry.register('gop', () => {})
    const tag = (event: ScrcpyVideoEvent): string =>
      event.type === 'frame' ? `${event.frame.keyFrame ? 'K' : 'D'}${event.frame.pts}` : 'M'
    scrcpyVideoRegistry.pushFrame('gop', {
      config: false,
      keyFrame: true,
      pts: '1',
      bytes: new ArrayBuffer(2)
    })
    scrcpyVideoRegistry.pushFrame('gop', {
      config: false,
      keyFrame: false,
      pts: '2',
      bytes: new ArrayBuffer(2)
    })

    const seen: string[] = []
    scrcpyVideoRegistry.subscribe('gop', (event) => seen.push(tag(event)))()
    expect(seen).toEqual(['K1', 'D2'])

    scrcpyVideoRegistry.pushFrame('gop', {
      config: false,
      keyFrame: true,
      pts: '3',
      bytes: new ArrayBuffer(2)
    })
    const seen2: string[] = []
    scrcpyVideoRegistry.subscribe('gop', (event) => seen2.push(tag(event)))()
    expect(seen2).toEqual(['K3'])

    scrcpyVideoRegistry.stop('gop')
  })

  it('does not buffer deltas that arrive before the first keyframe', () => {
    scrcpyVideoRegistry.register('predelta', () => {})
    scrcpyVideoRegistry.pushFrame('predelta', {
      config: false,
      keyFrame: false,
      pts: '1',
      bytes: new ArrayBuffer(2)
    })

    const frames: string[] = []
    const unsubscribe = scrcpyVideoRegistry.subscribe('predelta', (event) => {
      if (event.type === 'frame') {
        frames.push(event.frame.pts)
      }
    })
    expect(frames).toEqual([])
    scrcpyVideoRegistry.pushFrame('predelta', { ...frame(false), keyFrame: false, pts: '2' })
    expect(frames).toEqual([])
    scrcpyVideoRegistry.pushFrame('predelta', { ...frame(false), pts: '3' })
    expect(frames).toEqual(['3'])
    unsubscribe()
    scrcpyVideoRegistry.stop('predelta')
  })

  it.each([1, 10])('waits for a new keyframe after replay overflow for %s subscribers', (count) => {
    const device = `overflow-${count}`
    const close = vi.fn()
    scrcpyVideoRegistry.register(device, close)
    scrcpyVideoRegistry.pushMeta(device, { codecId: 'h264', width: 1, height: 2 })
    scrcpyVideoRegistry.pushFrame(device, frame(true))
    const liveFrames: string[] = []
    const stopLive = scrcpyVideoRegistry.subscribe(device, (event) => {
      if (event.type === 'frame' && !event.frame.config) {
        liveFrames.push(event.frame.pts)
      }
    })
    const push = (pts: number, keyFrame = false): void => {
      scrcpyVideoRegistry.pushFrame(device, {
        config: false,
        keyFrame,
        pts: String(pts),
        bytes: new ArrayBuffer(2)
      })
    }
    try {
      push(0, true)
      for (let i = 1; i <= 120; i++) {
        push(i)
      }
      const messages = Array.from({ length: count }, (): ScrcpyVideoEvent[] => [])
      const stops = messages.map((events) =>
        scrcpyVideoRegistry.subscribe(device, (event) => events.push(event))
      )
      messages.forEach((events) => expect(events).toHaveLength(2))
      expect(messages[0].map((event) => event.type)).toEqual(['meta', 'frame'])
      expect(messages[0][1]).toMatchObject({ frame: { config: true } })
      push(121)
      messages.forEach((events) => expect(events).toHaveLength(2))
      push(122, true)
      push(123)
      for (const events of messages) {
        expect(
          events.flatMap((event) =>
            event.type === 'frame' && !event.frame.config ? [event.frame.pts] : []
          )
        ).toEqual(['122', '123'])
      }
      expect(liveFrames).toEqual(Array.from({ length: 124 }, (_, i) => String(i)))
      stops.forEach((stop) => stop())
      push(124)
      messages.forEach((events) => expect(events).toHaveLength(4))
    } finally {
      stopLive()
      scrcpyVideoRegistry.stop(device)
    }
    expect(close).toHaveBeenCalledTimes(1)
    expect(scrcpyVideoRegistry.has(device)).toBe(false)
  })
})
