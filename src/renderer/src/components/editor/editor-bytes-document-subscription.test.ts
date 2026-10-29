import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { bytesDocumentBoxes } from './editor-bytes-document-boxes'
import {
  editorBytesDocument,
  editorBytesEdits,
  hasEditorBytesDraft,
  loadEditorBytes,
  releaseEditorBytes,
  retainEditorBytes,
  setEditorBytesDraft
} from './editor-bytes-documents'

const saved = { bytes: new Uint8Array([1, 2, 3]), fileType: 'xlsx' }
const draft = { bytes: new Uint8Array([1, 2, 4]), fileType: 'xlsx' }

function tab(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    worktreeId: 'wt',
    filePath: `/repo/${id}.xlsx`,
    relativePath: `${id}.xlsx`,
    language: 'plaintext',
    mode: 'edit',
    isDirty: false,
    runtimeEnvironmentId: 'env',
    ...patch
  }
}

const load = (id: string) => loadEditorBytes(id, saved, 'baseline', editorBytesEdits(id))
const title = (value: string) => useAppStore.getState().setRuntimePaneTitle('terminal', 0, value)

beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true))

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.restoreAllMocks()
})

describe('binary document store subscription', () => {
  it('skips document traversal for title updates but settles dirty changes', () => {
    const files = Array.from({ length: 100 }, (_, index) => tab(`book-${index}`))
    useAppStore.setState({ openFiles: files })
    for (const file of files.slice(-10)) {
      load(file.id)
    }
    const openFiles = useAppStore.getState().openFiles
    const iterator = vi.spyOn(bytesDocumentBoxes, Symbol.iterator)

    for (let index = 0; index < 100; index += 1) {
      title(`shell ${index}`)
    }

    expect(useAppStore.getState().openFiles).toBe(openFiles)
    expect(iterator).not.toHaveBeenCalled()
    expect(editorBytesDocument('book-99')).toBe(saved)

    setEditorBytesDraft('book-99', draft)
    expect(editorBytesDocument('book-99')).toBe(draft)
    useAppStore.getState().markFileDirty('book-99', false)
    expect(iterator).toHaveBeenCalled()
    expect(hasEditorBytesDraft('book-99')).toBe(false)
    expect(editorBytesDocument('book-99')).toBe(saved)
  })

  it('unsubscribes on final clean release and subscribes again on reload', () => {
    useAppStore.setState({ openFiles: [tab('book')] })
    const originalSubscribe = useAppStore.subscribe
    const stopped = vi.fn()
    const subscribe = vi.spyOn(useAppStore, 'subscribe').mockImplementation((listener) => {
      const stop = originalSubscribe(listener)
      return () => {
        stopped()
        stop()
      }
    })
    retainEditorBytes('book')
    load('book')

    releaseEditorBytes('book')

    expect(stopped).toHaveBeenCalledTimes(1)
    expect(editorBytesDocument('book')).toBeNull()
    retainEditorBytes('book')
    load('book')
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(editorBytesDocument('book')).toBe(saved)
    releaseEditorBytes('book')
  })

  it('does not admit a read completing after its tab closed', () => {
    useAppStore.setState({ openFiles: [tab('book')] })
    useAppStore.setState({ openFiles: [] })
    const subscribe = vi.spyOn(useAppStore, 'subscribe')

    load('book')

    expect(editorBytesDocument('book')).toBeNull()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('passes a closing draft to an unloaded twin after unrelated notifications', () => {
    useAppStore.setState({
      openFiles: [tab('book'), tab('twin', { worktreeId: 'other', filePath: '/repo/book.xlsx' })]
    })
    load('book')
    setEditorBytesDraft('book', draft)
    title('shell before close')

    useAppStore.setState((state) => ({
      openFiles: state.openFiles.filter((file) => file.id !== 'book')
    }))

    expect(editorBytesDocument('book')).toBeNull()
    expect(editorBytesDocument('twin')).toBe(draft)
    load('book')
    load('twin')
    expect(editorBytesDocument('twin')).toBe(draft)
  })

  it('uses the immediate previous sibling graph after a folder owner changes', () => {
    const first = makeFolderWorkspace({ id: 'a', executionHostId: 'local' })
    const second = makeFolderWorkspace({ id: 'b', executionHostId: 'local' })
    useAppStore.setState({
      folderWorkspaces: [first, second],
      openFiles: [
        tab('book', { worktreeId: 'folder:a', runtimeEnvironmentId: undefined }),
        tab('twin', {
          worktreeId: 'folder:b',
          filePath: '/repo/book.xlsx',
          runtimeEnvironmentId: undefined
        })
      ]
    })
    load('book')
    setEditorBytesDraft('book', draft)
    const before = useAppStore.getState()
    expect(before.editorBufferIdOf.book).toBe(before.editorBufferIdOf.twin)

    useAppStore.setState({
      folderWorkspaces: [first, { ...second, executionHostId: 'ssh:other' }]
    })
    const separated = useAppStore.getState()
    expect(separated.openFiles).toBe(before.openFiles)
    expect(separated.editorBufferIdOf.book).not.toBe(separated.editorBufferIdOf.twin)
    title('shell after owner change')
    useAppStore.setState({ openFiles: separated.openFiles.filter((file) => file.id !== 'book') })

    expect(editorBytesDocument('book')).toBeNull()
    expect(editorBytesDocument('twin')).toBeNull()
  })
})
