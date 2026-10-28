// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { AppState } from '@/store'
import MarkdownPreview from './MarkdownPreview'

const state = vi.hoisted(() => {
  const noop = () => {}
  const asyncNoop = async () => null
  const addDiffComment: AppState['addDiffComment'] = async () => null
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
    addDiffComment,
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

async function closePreviewWithPendingAnnotation(owner: number): Promise<WeakRef<DiffComment>> {
  const note: DiffComment = {
    id: `note-${owner}`,
    source: 'markdown',
    worktreeId: `owner-${owner}`,
    filePath: 'notes.md',
    lineNumber: 3,
    selectedText: 'Other block',
    body: `Unrelated existing note ${owner}`,
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
      content: `Selected block\n\nOther block ${owner}`,
      filePath: `${workspace.path}/notes.md`,
      sourceWorktreeId: workspace.id,
      sourceRuntimeEnvironmentId: null,
      scrollCacheKey: `pending-annotation-${owner}`,
      markdownAnnotationsEnabled: true
    }
  }
  try {
    await act(async () => view.root.render(<PreviewOwner view={view} />))
    const add = container.querySelector<HTMLButtonElement>('button[aria-label="Add note"]')
    if (!add) {
      throw new Error('Missing preview annotation action')
    }
    await act(async () => add.click())
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (!textarea || !setValue) {
      throw new Error('Missing preview annotation draft')
    }
    await act(async () => {
      setValue.call(textarea, 'Review selected block')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.markdown-annotation-composer button')
    ).find((button) => button.textContent?.includes('Add note'))
    if (!submit || submit.disabled) {
      throw new Error('Missing enabled annotation submit action')
    }
    await act(async () => submit.click())
    return new WeakRef(note)
  } finally {
    await act(async () => view.root.unmount())
    container.remove()
    state.worktreesByRepo = {}
    state.repos = []
  }
}

async function openSuccessorDraft(): Promise<() => Promise<void>> {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <>
        <textarea onChange={() => {}} />
        <button type="button" onClick={() => {}} />
      </>
    )
  )
  // Move React's input and development event bookkeeping off the retired preview.
  await act(async () => {
    container.querySelector('textarea')?.focus()
    container.querySelector('button')?.click()
  })
  return async () => {
    await act(async () => root.unmount())
    container.remove()
  }
}

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with --expose-gc to measure retired preview notes')
  }
  for (let round = 0; round < 4; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

for (const saved of [false, true]) {
  it(`releases closed preview notes while annotation saves are pending before ${saved ? 'success' : 'failure'}`, async () => {
    const save = Promise.withResolvers<DiffComment | null>()
    const inputs: Parameters<AppState['addDiffComment']>[0][] = []
    const previousAdd = state.addDiffComment
    state.addDiffComment = (input) => {
      inputs.push(input)
      return save.promise
    }
    const retired: WeakRef<DiffComment>[] = []
    let closeSuccessor: (() => Promise<void>) | undefined
    try {
      const previousStackTraceLimit = Error.stackTraceLimit
      try {
        // Production React omits the development owner stacks that capture render inputs.
        Error.stackTraceLimit = 0
        for (let owner = 0; owner < 4; owner++) {
          retired.push(await closePreviewWithPendingAnnotation(owner))
        }
      } finally {
        Error.stackTraceLimit = previousStackTraceLimit
      }
      closeSuccessor = await openSuccessorDraft()
      await collect()
      expect(inputs.length).toBe(4)
      expect(inputs.every((input) => input.selectedText === 'Selected block')).toBe(true)
      expect(inputs.every((input) => input.body === 'Review selected block')).toBe(true)
      expect(retired.filter((note) => note.deref()).length).toBe(0)
    } finally {
      save.resolve(
        saved
          ? {
              id: 'saved',
              source: 'markdown',
              worktreeId: 'owner-0',
              filePath: 'notes.md',
              lineNumber: 1,
              body: 'Review selected block',
              side: 'modified',
              createdAt: 0
            }
          : null
      )
      await act(async () => {
        await save.promise
        await new Promise<void>((resolve) => setImmediate(resolve))
      })
      state.addDiffComment = previousAdd
      await closeSuccessor?.()
    }
  })
}
