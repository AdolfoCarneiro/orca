import { inlineChildren, inlineMarkdown } from './html-inline-markdown'
import { codeFenceFor, openingFence } from './markdown-code-fence'

// Remove checkbox label/nested lists on clone only: live checkbox must remain, nested lists serialize at own indentation.
export function listItemText(item: Element): string {
  const clone = item.cloneNode(true)
  // `cloneNode` is typed as returning a `Node`; an element's deep copy is an element.
  if (!(clone instanceof Element)) {
    return ''
  }
  clone.querySelectorAll('label').forEach((label) => label.remove())
  clone.querySelectorAll('ul, ol').forEach((list) => list.remove())
  let last = clone.lastChild
  while (last) {
    if (
      last.nodeType === Node.COMMENT_NODE ||
      (last instanceof Element && /^(ul|ol|label)$/i.test(last.tagName))
    ) {
      last = last.previousSibling
      continue
    }
    break
  }
  let previous = last?.previousSibling
  while (previous instanceof Element && previous.lastChild) {
    previous = previous.lastChild
  }
  if (
    last instanceof Element &&
    last.tagName.toLowerCase() === 'br' &&
    !(previous instanceof Element && previous.tagName.toLowerCase() === 'br')
  ) {
    last.remove()
  }
  const markdown = inlineChildren(clone, '<br />', true)
    .replace(/\r\n?|\n/g, ' ')
    .trim()
  return markdown === '<br />' ? '' : markdown
}

function listCodeBlockMarkdown(node: Element): string {
  const parts: string[] = []
  const pending: Node[] = []
  for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
    const child = node.childNodes.item(index)
    if (child) {
      pending.push(child)
    }
  }
  while (pending.length) {
    const child = pending.pop()!
    if (child.nodeType === Node.TEXT_NODE) {
      parts.push(child.textContent ?? '')
    } else if (child instanceof Element) {
      if (child.tagName.toLowerCase() === 'br') {
        parts.push('\n')
      } else {
        for (let index = child.childNodes.length - 1; index >= 0; index -= 1) {
          const nested = child.childNodes.item(index)
          if (nested) {
            pending.push(nested)
          }
        }
      }
    }
  }
  const code = parts.join('')
  const fence = codeFenceFor(code)
  return `${fence}${node.getAttribute('data-language') ?? ''}\n${code}\n${fence}`
}

function hasOwnedCodeBlock(item: Element): boolean {
  const pending = Array.from(item.children)
  while (pending.length) {
    const node = pending.pop()!
    const tag = node.tagName.toLowerCase()
    if (tag === 'pre') {
      return true
    }
    if (tag === 'p' || tag === 'div') {
      for (const child of node.children) {
        pending.push(child)
      }
    }
  }
  return false
}

function listItemCodeBlocks(item: Element): string[] | null {
  if (!hasOwnedCodeBlock(item)) {
    return null
  }
  const blocks: string[] = []
  let inline: Node[] = []
  let nested = false
  const flush = () => {
    if (!inline.some((node) => node instanceof Element || node.textContent?.trim())) {
      inline = []
      return
    }
    const markdown = inline
      .map((node) => inlineMarkdown(node, '<br />', true))
      .join('')
      .trim()
    if (markdown) {
      blocks.push(markdown)
    }
    inline = []
  }
  const pending: (Node | null)[] = []
  const pushChildren = (parent: Node) => {
    for (let index = parent.childNodes.length - 1; index >= 0; index -= 1) {
      const child = parent.childNodes.item(index)
      if (child) {
        pending.push(child)
      }
    }
  }
  pushChildren(item)
  while (pending.length) {
    const node = pending.pop()
    if (!node) {
      flush()
      continue
    }
    if (node instanceof Element) {
      const tag = node.tagName.toLowerCase()
      if (/^(ul|ol|label)$/.test(tag)) {
        nested ||= tag !== 'label'
        continue
      }
      if (nested) {
        return null
      }
      if (tag === 'pre') {
        const language = node.getAttribute('data-language') ?? ''
        if (openingFence(`\`\`\`${language}`)?.language !== language) {
          return null
        }
        flush()
        blocks.push(listCodeBlockMarkdown(node))
        continue
      }
      if (tag === 'p' || tag === 'div') {
        flush()
        pending.push(null)
        pushChildren(node)
        continue
      }
    }
    if (nested && node.textContent?.trim()) {
      return null
    }
    inline.push(node)
  }
  flush()
  return blocks
}

/** The lists directly inside an item, rather than every list anywhere beneath it. */
export function directNestedLists(item: Element): Element[] {
  return Array.from(item.querySelectorAll('ul, ol')).filter((list) => list.closest('li') === item)
}

// Non-li-owned lists are standalone blocks wherever engine placed them, including inside p; li-owned nested lists serialize at own indentation.
export function holdsUnownedList(element: Element): boolean {
  return Array.from(element.querySelectorAll('ul, ol')).some((list) => list.closest('li') === null)
}

// Indent two spaces per list level; prefer markup item number over position to preserve pasted/split browser renumbering.
export function listMarkdown(element: Element, depth: number): string {
  const tag = element.tagName.toLowerCase()
  const isTask = element.getAttribute('data-type') === 'taskList'
  const parsedStart = tag === 'ol' ? Number.parseInt(element.getAttribute('start') ?? '1', 10) : 1
  const orderedStart = Number.isFinite(parsedStart) ? parsedStart : 1
  const indent = '  '.repeat(depth)
  return Array.from(element.children)
    .map((item, index) => {
      if (item.tagName.toLowerCase() !== 'li') {
        return ''
      }
      let marker: string
      if (isTask) {
        const input = item.querySelector<HTMLInputElement>('input[type="checkbox"]')
        marker = `- [${input && input.checked ? 'x' : ' '}] `
      } else {
        // `||` rather than `??`: an empty attribute is no number, and the next source answers.
        const listNumber = item.getAttribute('data-list-number') || item.getAttribute('value')
        marker = tag === 'ol' ? `${listNumber || orderedStart + index}. ` : '- '
      }
      const codeBlocks = listItemCodeBlocks(item)
      const blocks =
        isTask && openingFence(codeBlocks?.[0]?.split('\n')[0] ?? '') ? null : codeBlocks
      const continuation = indent + ' '.repeat(tag === 'ol' ? marker.length : 2)
      const body = blocks?.join('\n\n') ?? ''
      const line = blocks
        ? indent + marker + body.split('\n').join(`\n${continuation}`)
        : indent + marker + listItemText(item)
      const nested = directNestedLists(item)
        .map((list) => {
          const markdown = listMarkdown(list, depth + 1)
          const extraIndent = blocks ? Math.max(0, continuation.length - indent.length - 2) : 0
          return extraIndent
            ? markdown
                .split('\n')
                .map((line) => ' '.repeat(extraIndent) + line)
                .join('\n')
            : markdown
        })
        .filter(Boolean)
        .join('\n')
      return nested ? `${line}\n${nested}` : line
    })
    .filter(Boolean)
    .join('\n')
}
