import type { Editor } from '@tiptap/core'
import type { Slice } from '@tiptap/pm/model'
import { NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state'
import { dropPoint } from '@tiptap/pm/transform'
import { handlePaste as handleTablePaste } from '@tiptap/pm/tables'
import { closeHistory } from '@tiptap/pm/history'
import type { RichMarkdownImageInsertionRange } from './rich-markdown-image-insertion-target'
import { richMarkdownClipboardInsertionOrderKey } from './rich-markdown-clipboard-insertion-order'

export function insertRichMarkdownPastedImages(
  owner: Editor,
  importedSlice: Slice,
  range: RichMarkdownImageInsertionRange
): void {
  const liveSelection = owner.state.selection
  const selectionStillAtTarget = range.cellSelection
    ? liveSelection.eq(range.cellSelection)
    : liveSelection.from === range.from && liveSelection.to === range.to
  const pasteSelection =
    range.cellSelection ??
    TextSelection.between(owner.state.doc.resolve(range.from), owner.state.doc.resolve(range.to))
  const state = owner.state.apply(
    owner.state.tr.setSelection(pasteSelection).setMeta('addToHistory', false)
  )
  const dispatch = (tr: Transaction): void => {
    closeHistory(tr)
    if (selectionStillAtTarget) {
      tr.scrollIntoView()
    } else {
      tr.setSelection(liveSelection.map(tr.doc, tr.mapping))
    }
    owner.view.dispatch(
      tr
        .setMeta('paste', true)
        .setMeta('uiEvent', 'paste')
        .setMeta(richMarkdownClipboardInsertionOrderKey, range.requestOrder)
    )
  }
  // Native table paste needs the mapped selection while the user's live caret can move.
  const view = new Proxy(owner.view, {
    get(original, property, receiver) {
      if (property === 'state') {
        return state
      }
      if (property === 'dispatch') {
        return dispatch
      }
      // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap forwards native view members.
      return Reflect.get(original, property, receiver)
    }
  })
  if (!handleTablePaste(view, new ClipboardEvent('paste'), importedSlice)) {
    dispatch(state.tr.replaceSelection(importedSlice))
  }
}

export function insertRichMarkdownDroppedImages(
  owner: Editor,
  slice: Slice,
  range: RichMarkdownImageInsertionRange
): void {
  const insertPos = dropPoint(owner.state.doc, range.from, slice) ?? range.from
  const tr = owner.state.tr
  const singleNode =
    slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
      ? slice.content.firstChild
      : null
  if (singleNode) {
    tr.replaceRangeWith(insertPos, insertPos, singleNode)
  } else {
    tr.replaceRange(insertPos, insertPos, slice)
  }
  if (tr.doc.eq(owner.state.doc)) {
    return
  }
  if (range.selectionUnchanged) {
    const $pos = tr.doc.resolve(insertPos)
    if (
      singleNode &&
      NodeSelection.isSelectable(singleNode) &&
      $pos.nodeAfter?.sameMarkup(singleNode)
    ) {
      tr.setSelection(new NodeSelection($pos))
    } else {
      let end = tr.mapping.map(insertPos)
      tr.mapping.maps.at(-1)?.forEach((_from, _to, _newFrom, newTo) => {
        end = newTo
      })
      const $end = tr.doc.resolve(end)
      tr.setSelection(
        owner.view.someProp('createSelectionBetween', (create) => create(owner.view, $pos, $end)) ??
          TextSelection.between($pos, $end)
      )
    }
    tr.scrollIntoView()
  } else {
    tr.setSelection(owner.state.selection.map(tr.doc, tr.mapping))
  }
  owner.view.dispatch(
    closeHistory(tr)
      .setMeta('uiEvent', 'drop')
      .setMeta(richMarkdownClipboardInsertionOrderKey, range.requestOrder)
  )
}
