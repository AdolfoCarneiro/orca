import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { vi } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { syncDocLinkMenu } from './rich-markdown-commands'
import { useRichMarkdownMenuController } from './useRichMarkdownMenuController'

export type CountedDocuments = {
  documents: MarkdownDocument[]
  plain: MarkdownDocument[]
  reads: number
}

export function createCountedDocuments(count: number, owner = 0): CountedDocuments {
  const result: CountedDocuments = { documents: [], plain: [], reads: 0 }
  for (let index = 0; index < count; index++) {
    const prefix = index % 2 === 0 ? 'doc' : 'other'
    const basename = `${prefix}-${owner}-${String(count - index).padStart(5, '0')}.md`
    const relativePath = `section-${index % 3}/${basename}`
    const document: MarkdownDocument = {
      filePath: `/repo/${relativePath}`,
      relativePath,
      basename,
      name: basename.slice(0, -3)
    }
    result.plain.push(document)
    Object.defineProperty(result.documents, index, {
      configurable: true,
      enumerable: true,
      get() {
        result.reads += 1
        return document
      }
    })
  }
  return result
}

export type MenuOwner = {
  root: Root
  container: HTMLDivElement
  editor: Editor | null
  documents: MarkdownDocument[] | undefined
  controller: ReturnType<typeof useRichMarkdownMenuController> | null
  triggerPositions: number[]
  syncCalls: number
}

function MenuOwnerView({ owner }: { owner: MenuOwner }) {
  owner.controller = useRichMarkdownMenuController({ markdownDocuments: owner.documents })
  return <span>{owner.controller.docLinkTotalMatches}</span>
}

export function menuController(owner: MenuOwner): ReturnType<typeof useRichMarkdownMenuController> {
  if (!owner.controller) {
    throw new Error('Missing Markdown menu controller')
  }
  return owner.controller
}

export function menuEditor(owner: MenuOwner): Editor {
  if (!owner.editor) {
    throw new Error('Missing Markdown menu editor')
  }
  return owner.editor
}

export async function renderMenuOwner(owner: MenuOwner): Promise<void> {
  await act(async () => owner.root.render(<MenuOwnerView owner={owner} />))
}

export async function selectTrigger(owner: MenuOwner, index: number): Promise<void> {
  const position = owner.triggerPositions[index]
  if (position === undefined) {
    throw new Error('Missing Markdown completion trigger')
  }
  await act(async () => {
    menuEditor(owner).commands.setTextSelection(position)
  })
}

export async function createMenuOwner(
  documents: MarkdownDocument[],
  query = 'doc'
): Promise<MenuOwner> {
  const container = document.body.appendChild(document.createElement('div'))
  const reactElement = container.appendChild(document.createElement('div'))
  const editorElement = container.appendChild(document.createElement('div'))
  const owner: MenuOwner = {
    root: createRoot(reactElement),
    container,
    editor: null,
    documents,
    controller: null,
    triggerPositions: [],
    syncCalls: 0
  }
  try {
    await renderMenuOwner(owner)
    const synchronize = ({ editor }: { editor: Editor }): void => {
      owner.syncCalls += 1
      syncDocLinkMenu(editor, owner.container, menuController(owner).setDocLinkMenu)
    }
    owner.editor = new Editor({
      element: editorElement,
      extensions: [StarterKit],
      content: {
        type: 'doc',
        content: Array.from({ length: 2 }, () => ({
          type: 'paragraph',
          content: [{ type: 'text', text: `[[${query} suffix` }]
        }))
      },
      onSelectionUpdate: synchronize,
      onUpdate: synchronize
    })
    owner.editor.state.doc.forEach((_node, offset) => {
      owner.triggerPositions.push(offset + query.length + 3)
    })
    vi.spyOn(owner.editor.view, 'coordsAtPos').mockImplementation((position) => ({
      left: position * 3,
      right: position * 3 + 1,
      top: position * 2,
      bottom: position * 2 + 20
    }))
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(5, 7, 300, 200))
    await selectTrigger(owner, 0)
    return owner
  } catch (error) {
    await disposeMenuOwner(owner)
    throw error
  }
}

export async function disposeMenuOwner(owner: MenuOwner): Promise<void> {
  owner.editor?.destroy()
  owner.editor = null
  await act(async () => owner.root.unmount())
  owner.controller = null
  owner.documents = undefined
  owner.container.remove()
}
