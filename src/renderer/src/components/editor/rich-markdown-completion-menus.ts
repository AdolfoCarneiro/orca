import type { Editor } from '@tiptap/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { syncSlashMenu, type SlashMenuState } from './rich-markdown-slash-commands'
import { syncDocLinkMenu, type DocLinkMenuState } from './rich-markdown-commands'

export function syncRichMarkdownCompletionMenus(
  editor: Editor,
  rootRef: MutableRefObject<HTMLDivElement | null>,
  setSlashMenu: Dispatch<SetStateAction<SlashMenuState | null>>,
  setDocLinkMenu: Dispatch<SetStateAction<DocLinkMenuState | null>>
): void {
  let prefixState: Editor['state'] | undefined
  let prefix = ''
  const readBlockTextBeforeCursor = (): string => {
    const state = editor.state
    if (prefixState !== state) {
      const { $from } = state.selection
      prefix = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0')
      prefixState = state
    }
    return prefix
  }
  syncSlashMenu(editor, rootRef.current, setSlashMenu, readBlockTextBeforeCursor)
  syncDocLinkMenu(editor, rootRef.current, setDocLinkMenu, readBlockTextBeforeCursor)
}
