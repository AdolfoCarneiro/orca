import type { Editor } from '@tiptap/react'
import type { Transaction } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { CellSelection } from '@tiptap/pm/tables'
import { getRichMarkdownImageResolverContextVersion } from './rich-markdown-image-context'
import {
  captureRichMarkdownClipboardInsertionOrder,
  richMarkdownClipboardInsertionOrderKey
} from './rich-markdown-clipboard-insertion-order'

export type RichMarkdownImageInsertionRange = {
  from: number
  to: number
  requestOrder: number
  cellSelection?: CellSelection
  selectionUnchanged?: boolean
}

export type RichMarkdownImageInsertionTarget = {
  signal: AbortSignal
  getEditor: () => Editor | null
  getRange: () => RichMarkdownImageInsertionRange | null
  dispose: () => void
}

export function captureRichMarkdownImageInsertionTarget(
  editor: Editor,
  {
    includeSingleCellSelection = false,
    position
  }: { includeSingleCellSelection?: boolean; position?: number } = {}
): RichMarkdownImageInsertionTarget | null {
  if (editor.isDestroyed || !editor.view.dom.isConnected || !editor.isEditable) {
    return null
  }
  if (
    position !== undefined &&
    (!Number.isInteger(position) || position < 0 || position > editor.state.doc.content.size)
  ) {
    return null
  }
  let selectionChanged = false
  let activeEditor: Editor | null = editor
  let targetDom: HTMLElement | null = editor.view.dom
  const contextVersion = getRichMarkdownImageResolverContextVersion(editor)
  const requestOrder = captureRichMarkdownClipboardInsertionOrder(editor)
  let cellSelection =
    position === undefined &&
    editor.state.selection instanceof CellSelection &&
    (includeSingleCellSelection || editor.state.selection.ranges.length > 1)
      ? editor.state.selection
      : null
  let ranges =
    position === undefined
      ? editor.state.selection.ranges.map(({ $from, $to }) => ({ from: $from.pos, to: $to.pos }))
      : [{ from: position, to: position }]
  let document: ProseMirrorNode | null = editor.state.doc
  let active = true
  const controller = new AbortController()

  const dispose = (): void => {
    if (!active) {
      return
    }
    active = false
    const owner = activeEditor
    activeEditor = null
    targetDom = null
    document = null
    cellSelection = null
    ranges = []
    owner?.off('transaction', mapTransactions)
    owner?.off('destroy', dispose)
    // Error reasons can retain the editor's destruction stack.
    controller.abort('Image insertion target is no longer available.')
  }

  const mapTransactions = ({
    transaction,
    appendedTransactions
  }: {
    transaction: Transaction
    appendedTransactions: Transaction[]
  }): void => {
    if (!document) {
      return
    }
    const transactions = [transaction, ...appendedTransactions]
    if (position !== undefined) {
      selectionChanged ||= transactions.some((next) => next.selectionSet)
    }
    const nextDocument = appendedTransactions.at(-1)?.doc ?? transaction.doc
    if (nextDocument.eq(document)) {
      document = nextDocument
      return
    }
    if (!transaction.before.eq(document)) {
      dispose()
      return
    }
    const insertionOrder: unknown = transaction.getMeta(richMarkdownClipboardInsertionOrderKey)
    for (const nextTransaction of transactions) {
      for (const map of nextTransaction.mapping.maps) {
        const mappedRanges: { from: number; to: number }[] = []
        for (const range of ranges) {
          const collapsed = range.from === range.to
          let overlapsSelection = false
          if (!collapsed) {
            map.forEach((from, to) => {
              overlapsSelection ||=
                to > from
                  ? from < range.to && to > range.from
                  : cellSelection
                    ? from >= range.from && from <= range.to
                    : from > range.from && from < range.to
            })
          }
          if (overlapsSelection) {
            dispose()
            return
          }
          // Pending pastes keep their request order, ahead of later ordinary typing.
          const assoc = typeof insertionOrder === 'number' && insertionOrder < requestOrder ? 1 : -1
          const from = map.mapResult(range.from, collapsed ? assoc : 1)
          const to = map.mapResult(range.to, collapsed ? assoc : -1)
          if (from.deletedAcross || to.deletedAcross || from.pos > to.pos) {
            dispose()
            return
          }
          mappedRanges.push({ from: from.pos, to: to.pos })
        }
        ranges = mappedRanges
      }
      if (cellSelection) {
        const mapped = cellSelection.map(nextTransaction.doc, nextTransaction.mapping)
        if (
          !(mapped instanceof CellSelection) ||
          mapped.ranges.length !== ranges.length ||
          mapped.ranges.some(
            ({ $from, $to }, index) =>
              $from.pos !== ranges[index].from || $to.pos !== ranges[index].to
          )
        ) {
          dispose()
          return
        }
        cellSelection = mapped
      }
    }
    document = nextDocument
  }

  editor.on('transaction', mapTransactions)
  editor.on('destroy', dispose)

  return {
    signal: controller.signal,
    dispose,
    getEditor: () => activeEditor,
    getRange: () => {
      const owner = activeEditor
      return active &&
        owner &&
        document &&
        targetDom &&
        !owner.isDestroyed &&
        owner.isEditable &&
        owner.view.dom === targetDom &&
        targetDom.isConnected &&
        getRichMarkdownImageResolverContextVersion(owner) === contextVersion &&
        owner.state.doc.eq(document)
        ? {
            ...ranges[0],
            requestOrder,
            ...(cellSelection ? { cellSelection } : {}),
            ...(position === undefined ? {} : { selectionUnchanged: !selectionChanged })
          }
        : null
    }
  }
}
