// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import { useMarkdownDocuments } from './useMarkdownDocuments'
import { useRichMarkdownMenuController } from './useRichMarkdownMenuController'

const runtime = vi.hoisted(() => {
  const requests: ((documents: MarkdownDocument[]) => void)[] = []
  return {
    requests,
    list: () => new Promise<MarkdownDocument[]>((resolve) => requests.push(resolve))
  }
})
const state = vi.hoisted(() => ({
  worktreesByRepo: {
    repo: [{ id: 'wt', repoId: 'repo', path: '/repo', hostId: 'local' }]
  },
  repos: [{ id: 'repo', path: '/repo', hostId: 'local', connectionId: null }],
  folderWorkspaces: [],
  projectGroups: [],
  runtimeEnvironments: [],
  openFile() {},
  openMarkdownPreview() {}
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (snapshot: typeof state) => unknown) => selector(state), {
    getState: () => state,
    subscribe: () => () => {}
  })
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en', resolvedLanguage: 'en', on() {}, off() {} },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/runtime/runtime-file-metadata-client', () => ({
  listRuntimeMarkdownDocuments: runtime.list,
  statRuntimePath: async () => ({ size: 1, isDirectory: false, mtime: 1 })
}))

type ListingView = {
  root: Root
  container: HTMLDivElement
  kind: 'documents' | 'menu'
  mode: MarkdownViewMode
  documents: MarkdownDocument[]
  controller: ReturnType<typeof useMarkdownDocuments> | null
}
const file: OpenFile = {
  id: 'source',
  filePath: '/repo/source.md',
  relativePath: 'source.md',
  worktreeId: 'wt',
  language: 'markdown',
  isDirty: false,
  runtimeEnvironmentId: null,
  mode: 'edit'
}
const save = async (): Promise<boolean> => true

function DocumentOwner({ view }: { view: ListingView }) {
  const controller = useMarkdownDocuments(file, true, view.mode, save)
  view.controller = controller
  return <span>{controller.markdownDocuments.length}</span>
}
function MenuOwner({ view }: { view: ListingView }) {
  const menu = useRichMarkdownMenuController({ markdownDocuments: view.documents })
  return <span>{menu.docLinkTotalMatches}</span>
}
async function renderListing(view: ListingView): Promise<void> {
  await act(async () => {
    view.root.render(
      view.kind === 'documents' ? <DocumentOwner view={view} /> : <MenuOwner view={view} />
    )
  })
}
async function finishListing(documents: MarkdownDocument[]): Promise<void> {
  const finish = runtime.requests.shift()
  if (!finish) {
    throw new Error('Missing native Markdown listing')
  }
  await act(async () => finish(documents))
}
async function prepareListing(kind: ListingView['kind'], owner: number) {
  const stackTraceLimit = Error.stackTraceLimit
  // React development CallSites can own render inputs; production React has no debug stack.
  Error.stackTraceLimit = 0
  const container = document.body.appendChild(document.createElement('div'))
  const documents = Array.from({ length: 100 }, (_, index) => {
    const basename = `document-${owner}-${index}.md`
    return {
      filePath: `/repo/${basename}`,
      relativePath: basename,
      basename,
      name: basename.slice(0, -3)
    }
  })
  const view: ListingView = {
    container,
    root: createRoot(container),
    kind,
    mode: 'source',
    documents,
    controller: null
  }
  try {
    await renderListing(view)
    if (kind === 'documents') {
      await finishListing(documents)
      expect(view.controller?.markdownDocuments).toBe(documents)
      view.mode = 'rich'
      await renderListing(view)
    }
    const retired = new WeakRef(documents)
    view.documents = [
      {
        filePath: '/repo/current.md',
        relativePath: 'current.md',
        basename: 'current.md',
        name: 'current'
      }
    ]
    if (kind === 'documents') {
      await finishListing(view.documents)
    }
    for (let update = 0; update < 4; update++) {
      await renderListing(view)
    }
    return { view, retired }
  } catch (error) {
    await act(async () => view.root.unmount())
    container.remove()
    throw error
  } finally {
    Error.stackTraceLimit = stackTraceLimit
  }
}
async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with --expose-gc')
  }
  for (let round = 0; round < 6; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}
for (const kind of ['documents', 'menu'] as const) {
  it(`releases retired Markdown lists while the ${kind} owner stays mounted`, async () => {
    const tasks: Awaited<ReturnType<typeof prepareListing>>[] = []
    try {
      for (let owner = 0; owner < 4; owner++) {
        tasks.push(await prepareListing(kind, owner))
      }
      for (let update = 0; update < 3; update++) {
        for (const { view } of tasks) {
          await renderListing(view)
        }
      }
      await collect()
      expect(
        tasks.every(({ view }) => view.container.textContent === (kind === 'documents' ? '1' : '0'))
      ).toBe(true)
      expect(tasks.filter(({ retired }) => retired.deref()).length).toBe(0)
    } finally {
      for (const { view } of tasks) {
        await act(async () => view.root.unmount())
        view.controller = null
        view.documents = []
        view.container.remove()
      }
    }
  })
}
