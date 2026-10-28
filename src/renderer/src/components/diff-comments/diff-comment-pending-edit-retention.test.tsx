// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import MarkdownPreview from '../editor/MarkdownPreview'

const state = vi.hoisted(() => ({
  openFile() {},
  activateMarkdownLink() {},
  openMarkdownPreview() {},
  setMarkdownViewMode() {},
  markdownFrontmatterVisible: {},
  setPendingEditorReveal() {},
  addDiffComment: async () => null,
  deleteDiffComment: async () => null,
  updateDiffComment: async (_worktreeId: string, _commentId: string, _body: string) => true,
  clearDeliveredDiffComments: async () => null,
  keybindings: {},
  worktreesByRepo: {},
  repos: [],
  folderWorkspaces: [],
  projectGroups: [],
  openFiles: [],
  activeFileIdByWorktree: {},
  settings: { openLinksInApp: true, theme: 'light' },
  editorFontZoomLevel: 0,
  runtimeEnvironments: []
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
vi.mock('../editor/NotesSendMenu', () => ({ NotesSendMenu: () => null }))

type PreviewView = {
  root: Root
  container: HTMLDivElement
  options: ComponentProps<typeof MarkdownPreview> | null
}
type NoteWorkspace = {
  id: string
  repoId: string
  path: string
  hostId: string
  diffComments: DiffComment[]
}

function PreviewOwner({ view }: { view: PreviewView }) {
  return view.options ? <MarkdownPreview {...view.options} /> : null
}

async function preparePendingEdit(owner: number): Promise<WeakRef<NoteWorkspace>> {
  const stackTraceLimit = Error.stackTraceLimit
  // React development CallSites can own render inputs; production React has no debug stack.
  Error.stackTraceLimit = 0
  try {
    return await openPendingEditPreview(owner)
  } finally {
    Error.stackTraceLimit = stackTraceLimit
  }
}

async function openPendingEditPreview(owner: number): Promise<WeakRef<NoteWorkspace>> {
  const original: DiffComment = {
    id: `edited-${owner}`,
    source: 'markdown',
    worktreeId: `owner-${owner}`,
    filePath: 'note.md',
    lineNumber: 1,
    body: `Original note ${owner}`,
    side: 'modified',
    createdAt: owner
  }
  const unrelated: DiffComment = {
    ...original,
    id: `unrelated-${owner}`,
    filePath: 'other.md',
    body: `Unrelated note ${owner}`
  }
  const repoId = `repo-${owner}`
  const workspace: NoteWorkspace = {
    id: `owner-${owner}`,
    repoId,
    path: `/folder-${owner}`,
    hostId: 'local',
    diffComments: [original, unrelated]
  }
  state.worktreesByRepo = {
    [repoId]: [workspace]
  }
  const container = document.body.appendChild(document.createElement('div'))
  const view: PreviewView = {
    container,
    root: createRoot(container),
    options: {
      content: 'A small existing quote.',
      filePath: `/folder-${owner}/note.md`,
      sourceWorktreeId: `owner-${owner}`,
      sourceRuntimeEnvironmentId: null,
      scrollCacheKey: `pending-edit-${owner}`,
      markdownAnnotationsEnabled: true
    }
  }
  try {
    await act(async () => view.root.render(<PreviewOwner view={view} />))
    const edit = view.container.querySelector<HTMLButtonElement>('button[aria-label="Edit note"]')
    if (!edit) {
      throw new Error('Expected existing note edit action')
    }
    await act(async () => edit.click())
    const textarea = view.container.querySelector('textarea')
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (!textarea || !setValue) {
      throw new Error('Expected note edit field')
    }
    await act(async () => {
      setValue.call(textarea, `Updated note ${owner}`)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    )
    if (!submit || submit.disabled) {
      throw new Error('Expected enabled note Save action')
    }
    await act(async () => submit.click())
    return new WeakRef(workspace)
  } finally {
    await act(async () => view.root.unmount())
    view.options = null
    view.container.remove()
    state.worktreesByRepo = {}
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

async function mountSuccessor(): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  await act(async () => root.render(<textarea onChange={() => {}} />))
  const textarea = container.querySelector('textarea')
  if (!textarea) {
    throw new Error('Expected successor input')
  }
  textarea.focus()
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  return { root, container }
}

it('releases closed preview workspaces while existing-note edits remain pending', async () => {
  let complete: ((value: boolean) => void) | undefined
  const pending = new Promise<boolean>((resolve) => {
    complete = resolve
  })
  const previousUpdate = state.updateDiffComment
  let successor: Awaited<ReturnType<typeof mountSuccessor>> | undefined
  let submissions = 0
  state.updateDiffComment = async () => {
    submissions++
    return pending
  }
  try {
    const retired: WeakRef<NoteWorkspace>[] = []
    for (let owner = 0; owner < 4; owner++) {
      retired.push(await preparePendingEdit(owner))
    }
    successor = await mountSuccessor()
    await collect()
    expect(submissions).toBe(4)
    expect(retired.filter((workspace) => workspace.deref()).length).toBe(0)
  } finally {
    await act(async () => complete?.(true))
    if (successor) {
      await act(async () => successor?.root.unmount())
      successor.container.remove()
    }
    state.updateDiffComment = previousUpdate
  }
})
