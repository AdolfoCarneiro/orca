// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import MarkdownPreview from './MarkdownPreview'

const state = vi.hoisted(() => {
  const noop = () => {}
  const asyncNoop = async () => null
  const worktreesByRepo: Record<
    string,
    { id: string; repoId: string; path: string; hostId: string; diffComments: DiffComment[] }[]
  > = {}
  const repos: { id: string; path: string; hostId: string }[] = []
  return {
    openFile: noop,
    activateMarkdownLink: noop,
    openMarkdownPreview: noop,
    setMarkdownViewMode: noop,
    markdownFrontmatterVisible: {},
    setPendingEditorReveal: noop,
    addDiffComment: asyncNoop,
    deleteDiffComment: asyncNoop,
    updateDiffComment: asyncNoop,
    clearDeliveredDiffComments: asyncNoop,
    keybindings: {},
    worktreesByRepo,
    repos,
    folderWorkspaces: [],
    projectGroups: [],
    openFiles: [],
    activeFileIdByWorktree: {},
    settings: { openLinksInApp: true, theme: 'light' },
    editorFontZoomLevel: 0,
    runtimeEnvironments: []
  }
})

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
vi.mock('./NotesSendMenu', () => ({ NotesSendMenu: () => null }))

type PreviewView = {
  root: Root
  options: {
    content: string
    filePath: string
    sourceWorktreeId: string
    sourceRuntimeEnvironmentId: null
    scrollCacheKey: string
    markdownAnnotationsEnabled: boolean
  }
}

function PreviewOwner({ view }: { view: PreviewView }) {
  return <MarkdownPreview {...view.options} />
}

async function closePreviewWithPendingCopy(owner: number, single: boolean) {
  const note: DiffComment = {
    id: `note-${owner}`,
    source: 'markdown',
    worktreeId: `owner-${owner}`,
    filePath: 'notes.md',
    lineNumber: 1,
    selectedText: 'abc',
    body: 'tiny',
    side: 'modified',
    createdAt: owner
  }
  const repoId = `repo-${owner}`
  const workspace = {
    id: `owner-${owner}`,
    repoId,
    path: `/folder-${owner}`,
    hostId: 'local',
    diffComments: [note]
  }
  state.worktreesByRepo = { [repoId]: [workspace] }
  state.repos = [{ id: repoId, path: workspace.path, hostId: 'local' }]
  const container = document.body.appendChild(document.createElement('div'))
  const view: PreviewView = {
    root: createRoot(container),
    options: {
      content: `abc\n\n${'x'.repeat(100_000)}`,
      filePath: `${workspace.path}/notes.md`,
      sourceWorktreeId: workspace.id,
      sourceRuntimeEnvironmentId: null,
      scrollCacheKey: `pending-preview-${owner}`,
      markdownAnnotationsEnabled: true
    }
  }
  try {
    await act(async () => view.root.render(<PreviewOwner view={view} />))
    const label = single ? 'Copy note for agent' : 'Copy notes for agent'
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.getAttribute('aria-label') === label
    )
    if (!button) {
      throw new Error(`Missing preview action: ${label}`)
    }
    await act(async () => button.click())
    return new WeakRef(note)
  } finally {
    await act(async () => view.root.unmount())
    container.remove()
    state.worktreesByRepo = {}
    state.repos = []
  }
}

async function dispatchNeutralReactEvent(): Promise<void> {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<button type="button" onClick={() => {}} />))
    await act(async () => container.querySelector('button')?.click())
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with --expose-gc to measure retired preview inputs')
  }
  for (let round = 0; round < 4; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

for (const single of [false, true]) {
  it(`releases closed preview ${single ? 'individual' : 'all-note'} inputs before clipboard writes settle`, async () => {
    const clipboard = Promise.withResolvers<void>()
    const writes: string[] = []
    const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          writeClipboardText: (text: string) => {
            writes.push(text)
            return clipboard.promise
          }
        }
      }
    })
    const retired: WeakRef<DiffComment>[] = []
    try {
      for (let owner = 0; owner < 4; owner++) {
        retired.push(await closePreviewWithPendingCopy(owner, single))
      }
      // Development React keeps its last event target; move it off the retired preview.
      await dispatchNeutralReactEvent()
      await collect()
      expect(writes.length).toBe(4)
      expect(writes.every((text) => text.length < 100)).toBe(true)
      expect(retired.filter((note) => note.deref()).length).toBe(0)
    } finally {
      clipboard.resolve()
      await act(async () => clipboard.promise)
      if (previousApi) {
        Object.defineProperty(window, 'api', previousApi)
      } else {
        Reflect.deleteProperty(window, 'api')
      }
    }
  })
}
