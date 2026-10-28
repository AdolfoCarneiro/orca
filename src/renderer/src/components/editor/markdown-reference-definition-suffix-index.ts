type ReferenceDefinitionSuffixNode<T> = {
  children: Map<number, ReferenceDefinitionSuffixEdge<T>>
  value: T | undefined
}

type ReferenceDefinitionSuffixEdge<T> = {
  label: string
  start: number
  end: number
  child: ReferenceDefinitionSuffixNode<T>
}

function createReferenceDefinitionSuffixNode<T>(value?: T): ReferenceDefinitionSuffixNode<T> {
  return { children: new Map(), value }
}

function insertReferenceDefinitionSuffix<T>(
  root: ReferenceDefinitionSuffixNode<T>,
  label: string,
  value: T
): void {
  let node = root
  let position = label.length
  while (position > 0) {
    const code = label.charCodeAt(position - 1)
    const edge = node.children.get(code)
    if (!edge) {
      node.children.set(code, {
        label,
        start: 0,
        end: position,
        child: createReferenceDefinitionSuffixNode(value)
      })
      return
    }
    let labelIndex = position - 1
    let edgeIndex = edge.end - 1
    while (labelIndex >= 0 && edgeIndex >= edge.start) {
      if (label.charCodeAt(labelIndex) !== edge.label.charCodeAt(edgeIndex)) {
        break
      }
      labelIndex -= 1
      edgeIndex -= 1
    }
    position = labelIndex + 1
    if (edgeIndex < edge.start) {
      node = edge.child
      continue
    }
    const split = createReferenceDefinitionSuffixNode<T>()
    split.children.set(edge.label.charCodeAt(edgeIndex), {
      label: edge.label,
      start: edge.start,
      end: edgeIndex + 1,
      child: edge.child
    })
    edge.start = edgeIndex + 1
    edge.child = split
    if (position === 0) {
      split.value = value
    } else {
      split.children.set(label.charCodeAt(position - 1), {
        label,
        start: 0,
        end: position,
        child: createReferenceDefinitionSuffixNode(value)
      })
    }
    return
  }
  node.value = value
}

export function createReferenceDefinitionSuffixIndex<T>(
  definitions: Map<string, T>
): (content: string, end: number) => Map<number, T> {
  const root = createReferenceDefinitionSuffixNode<T>()
  for (const [label, value] of definitions) {
    insertReferenceDefinitionSuffix(root, label, value)
  }
  return (content, end) => {
    const matches = new Map<number, T>()
    let node = root
    let position = end
    if (node.value !== undefined) {
      matches.set(position, node.value)
    }
    while (position > 0) {
      const edge = node.children.get(content.charCodeAt(position - 1))
      if (!edge) {
        break
      }
      for (let index = edge.end - 1; index >= edge.start; index -= 1) {
        position -= 1
        if (position < 0 || content.charCodeAt(position) !== edge.label.charCodeAt(index)) {
          return matches
        }
      }
      node = edge.child
      if (node.value !== undefined) {
        matches.set(position, node.value)
      }
    }
    return matches
  }
}
