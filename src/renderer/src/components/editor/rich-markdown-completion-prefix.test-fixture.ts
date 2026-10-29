import { Fragment, Node as DocumentNode } from '@tiptap/pm/model'

export type PrefixRead = { from: number; to: number; codeUnits: number; nodes: number }

export function recordPrefixReads(action: () => void): PrefixRead[] {
  const reads: PrefixRead[] = []
  const textBetween = DocumentNode.prototype.textBetween
  const nodesBetween = Fragment.prototype.nodesBetween
  let active: { read: PrefixRead; fragment: Fragment } | undefined
  try {
    DocumentNode.prototype.textBetween = function (from, to, blockSeparator, leafText) {
      if (blockSeparator !== '\0' || leafText !== '\0') {
        return textBetween.call(this, from, to, blockSeparator, leafText)
      }
      const read = { from, to, codeUnits: 0, nodes: 0 }
      reads.push(read)
      const previous = active
      active = { read, fragment: this.content }
      try {
        const result = textBetween.call(this, from, to, blockSeparator, leafText)
        read.codeUnits = result.length
        return result
      } finally {
        active = previous
      }
    }
    Fragment.prototype.nodesBetween = function (from, to, callback, nodeStart, parent) {
      const read = active?.fragment === this ? active.read : undefined
      return nodesBetween.call(
        this,
        from,
        to,
        read
          ? (...args: Parameters<typeof callback>) => {
              read.nodes += 1
              return callback(...args)
            }
          : callback,
        nodeStart,
        parent
      )
    }
    action()
    return reads
  } finally {
    DocumentNode.prototype.textBetween = textBetween
    Fragment.prototype.nodesBetween = nodesBetween
  }
}
