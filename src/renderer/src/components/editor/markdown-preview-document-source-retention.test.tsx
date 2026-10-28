// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useMarkdownPreviewDocument } from './use-markdown-preview-document'

const SOURCE_BYTES = 2 * 1024 * 1024
const OWNER_COUNT = 4

type DocumentView = { root: Root; container: HTMLDivElement; content: string }

function DocumentOwner({ view }: { view: DocumentView }) {
  const state = useMarkdownPreviewDocument(view.content, false)
  return <div>{state.content === 'tiny-c' ? state.content : 'initial-source'}</div>
}

async function renderDocument(view: DocumentView): Promise<void> {
  await act(async () => view.root.render(<DocumentOwner view={view} />))
}

async function prepareDocument(owner: number): Promise<DocumentView> {
  const container = document.body.appendChild(document.createElement('div'))
  const view = {
    container,
    root: createRoot(container),
    content: ''
  }
  await act(async () => view.root.render(<div>warm</div>))
  view.content = Buffer.concat([
    Buffer.from(`Preview source ${owner}\n`),
    Buffer.alloc(SOURCE_BYTES, 120)
  ]).toString('utf8')
  await renderDocument(view)
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
  try {
    for (let owner = 0; owner < OWNER_COUNT; owner++) {
      views.push(await prepareDocument(owner))
    }
    expect(views.every((view) => view.content.length > SOURCE_BYTES)).toBe(true)
    const beforeReplacement = await collectedMemory()
    for (const content of ['tiny-a', 'tiny-b', 'tiny-c']) {
      for (const view of views) {
        view.content = content
        await renderDocument(view)
      }
    }
    const releasedBytes = beforeReplacement - (await collectedMemory())
    expect(views.every((view) => view.container.textContent === 'tiny-c')).toBe(true)
    expect(releasedBytes).toBeGreaterThan((OWNER_COUNT - 1) * SOURCE_BYTES)
  } finally {
    for (const view of views) {
      await act(async () => view.root.unmount())
      view.container.remove()
    }
  }
})
