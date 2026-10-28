// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollTopCache } from '@/lib/scroll-cache'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn<(id: string, content: string) => Promise<{ svg: string }>>()
}))
vi.mock('mermaid', () => ({ default: mermaid }))
vi.mock('dompurify', () => ({ default: { sanitize: (svg: string) => svg } }))

import MermaidViewer from './MermaidViewer'

const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0

beforeEach(() => {
  scrollTopCache.clear()
  frames.clear()
  mermaid.render.mockReset()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  scrollTopCache.clear()
})

function diagramViewport(container: HTMLElement, renderedHeight = 1200): HTMLElement {
  const viewer = container.querySelector('.mermaid-viewer')
  if (!(viewer instanceof HTMLElement)) {
    throw new Error('Missing diagram viewport')
  }
  let scrollTop = 0
  Object.defineProperties(viewer, {
    clientHeight: { get: () => 100 },
    scrollHeight: {
      get: () => (viewer.querySelector('.mermaid-block')?.hasChildNodes() ? renderedHeight : 100)
    },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, viewer.scrollHeight - viewer.clientHeight))
      }
    }
  })
  return viewer
}

function advanceFrames(count: number): void {
  for (let index = 0; index < count; index += 1) {
    const scheduled = [...frames.values()]
    frames.clear()
    scheduled.forEach((callback) => callback(index * 16))
  }
}

describe('Mermaid diagram scroll restoration', () => {
  it.each([
    { height: 1200, expected: 600 },
    { height: 300, expected: 200 }
  ])(
    'restores after a delayed render, clamping to $height pixels',
    async ({ height, expected }) => {
      const pending = Promise.withResolvers<{ svg: string }>()
      mermaid.render.mockReturnValueOnce(pending.promise)
      scrollTopCache.set('/diagram.mmd:mermaid-diagram', 600)
      const { container } = render(
        <MermaidViewer scrollCacheKey="/diagram.mmd:mermaid-diagram" content="flowchart TD\nA-->B" />
      )
      const viewer = diagramViewport(container, height)
      await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
      act(() => advanceFrames(40))
      expect(viewer.scrollTop).toBe(0)

      await act(async () => pending.resolve({ svg: '<svg><text>Diagram</text></svg>' }))

      expect(viewer.scrollTop).toBe(expected)
      expect(frames.size).toBe(0)
    }
  )

  it('preserves a pending position through unmount and ignores the abandoned render', async () => {
    const abandoned = Promise.withResolvers<{ svg: string }>()
    const current = Promise.withResolvers<{ svg: string }>()
    mermaid.render.mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(current.promise)
    scrollTopCache.set('/diagram.mmd:mermaid-diagram', 600)
    const first = render(<MermaidViewer scrollCacheKey="/diagram.mmd:mermaid-diagram" content="flowchart TD\nA-->B" />)
    const detached = diagramViewport(first.container)
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    first.unmount()
    expect(scrollTopCache.get('/diagram.mmd:mermaid-diagram')).toBe(600)
    const second = render(<MermaidViewer scrollCacheKey="/diagram.mmd:mermaid-diagram" content="flowchart TD\nA-->B" />)
    const viewer = diagramViewport(second.container)

    await act(async () => abandoned.resolve({ svg: '<svg><text>Abandoned</text></svg>' }))
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2))
    expect(detached.scrollTop).toBe(0)
    expect(viewer.scrollTop).toBe(0)
    await act(async () => current.resolve({ svg: '<svg><text>Current</text></svg>' }))

    expect(viewer.scrollTop).toBe(600)
    expect(frames.size).toBe(0)
  })
})
