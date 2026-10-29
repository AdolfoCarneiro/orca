import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { NATIVE_CHAT_UNKERNED_STYLE, nativeChatUnkernedRuns } from './native-chat-unkerned-runs'

function addBlockDecorations(
  decorations: Decoration[],
  block: ProseMirrorNode,
  blockPos: number
): void {
  block.forEach((child, offset) => {
    if (!child.isText) {
      return
    }
    const textPos = blockPos + 1 + offset
    for (const [start, end] of nativeChatUnkernedRuns(child.text ?? '')) {
      decorations.push(
        // Inclusive, so typing at a run's edge maps to the range a rescan finds.
        Decoration.inline(
          textPos + start,
          textPos + end,
          { style: NATIVE_CHAT_UNKERNED_STYLE },
          { inclusiveStart: true, inclusiveEnd: true }
        )
      )
    }
  })
}

function changedRanges(tr: Transaction): [number, number][] {
  const ranges: [number, number][] = []
  tr.mapping.maps.forEach((map, index) => {
    const rest = tr.mapping.slice(index + 1)
    map.forEach((_oldFrom, _oldTo, from, to) => {
      ranges.push([rest.map(from, -1), rest.map(to, 1)])
    })
  })
  return ranges
}

// Why incremental: rebuilding the whole set per keystroke is quadratic in decorated lines.
function applyChange(tr: Transaction, previous: DecorationSet): DecorationSet {
  const set = previous.map(tr.mapping, tr.doc)
  const { doc } = tr
  const stale: Decoration[] = []
  const fresh: Decoration[] = []
  const visited = new Set<number>()
  for (const [from, to] of changedRanges(tr)) {
    doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos) => {
      if (!node.isTextblock) {
        return true
      }
      if (!visited.has(pos)) {
        visited.add(pos)
        for (const decoration of set.find(pos, pos + node.nodeSize)) {
          stale.push(decoration)
        }
        addBlockDecorations(fresh, node, pos)
      }
      return false
    })
  }
  const byFrom = (a: Decoration, b: Decoration) => a.from - b.from
  stale.sort(byFrom)
  fresh.sort(byFrom)
  const unchanged =
    stale.length === fresh.length &&
    stale.every((old, index) => old.from === fresh[index].from && old.to === fresh[index].to)
  return unchanged ? set : set.remove(stale).add(doc, fresh)
}

function allDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      addBlockDecorations(decorations, node, pos)
      return false
    }
    return true
  })
  return DecorationSet.create(doc, decorations)
}

/** Turns kerning off only on runs long enough to stall layout; the text is untouched. */
export const NativeChatUnkernedRunDecorations = Extension.create({
  name: 'nativeChatUnkernedRunDecorations',
  addProseMirrorPlugins() {
    const key = new PluginKey<DecorationSet>('nativeChatUnkernedRunDecorations')
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => allDecorations(state.doc),
          apply: (tr, previous) => (tr.docChanged ? applyChange(tr, previous) : previous)
        },
        props: {
          decorations: (state) => key.getState(state)
        }
      })
    ]
  }
})
