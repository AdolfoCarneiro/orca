// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useMarkdownPreviewDocument } from './use-markdown-preview-document'

const SOURCE_BYTES = 2 * 1024 * 1024

type DocumentView = { root: Root; container: HTMLDivElement; content: string }

function DocumentOwner({ view }: { view: DocumentView }) {
  const state = useMarkdownPreviewDocument(view.content, false)
  return <div>{state.content}</div>
}

async function renderDocument(view: DocumentView): Promise<void> {
  await act(async () => view.root.render(<DocumentOwner view={view} />))
}

async function prepareDocument(owner: number): Promise<DocumentView> {
  const container = document.body.appendChild(document.createElement('div'))
  const view = {
    container,
    root: createRoot(container),
    content: Buffer.concat([
      Buffer.from(`Preview source ${owner}\n`),
      Buffer.alloc(SOURCE_BYTES, 120)
    ]).toString('utf8')
  }
  await renderDocument(view)
  for (const content of ['tiny-a', 'tiny-b', 'tiny-c']) {
    view.content = content
    await renderDocument(view)
  }
  return view
}

async function collectedMemory(): Promise<number> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with --expose-gc to measure retained document strings')
  }
  for (let round = 0; round < 6; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
  const memory = process.memoryUsage()
  return memory.heapUsed + memory.external
}

it('releases replaced source inputs while the preview document worker is disabled', async () => {
  const views: DocumentView[] = []
  const warmContainer = document.body.appendChild(document.createElement('div'))
  const warm = { root: createRoot(warmContainer), container: warmContainer, content: 'warm' }
  await renderDocument(warm)
  await act(async () => warm.root.unmount())
  warm.container.remove()
  const before = await collectedMemory()
  try {
    for (let owner = 0; owner < 4; owner++) {
      views.push(await prepareDocument(owner))
    }
    const retainedBytes = (await collectedMemory()) - before
    expect(views.every((view) => view.container.textContent === 'tiny-c')).toBe(true)
    expect(retainedBytes).toBeLessThan(SOURCE_BYTES)
  } finally {
    for (const view of views) {
      await act(async () => view.root.unmount())
      view.container.remove()
    }
  }
})
