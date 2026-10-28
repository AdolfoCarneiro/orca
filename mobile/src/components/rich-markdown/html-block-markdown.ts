import { codeFenceFor } from './markdown-code-fence'
import { escapeTableCell } from './markdown-table-rows'
import {
  inlineChildren,
  inlineMarkdown,
  literalTextContent,
  textContent
} from './html-inline-markdown'
import { holdsUnownedList, listMarkdown } from './html-list-markdown'

function* paragraphCodeNodes(element: Element): Generator<Node | null> {
  const pending: (Node | null)[] = []
  const pushChildren = (parent: Node) => {
    for (let index = parent.childNodes.length - 1; index >= 0; index -= 1) {
      const child = parent.childNodes.item(index)
      if (child) {
        pending.push(child)
      }
    }
  }
  pushChildren(element)
  while (pending.length) {
    const node = pending.pop() ?? null
    if (node instanceof Element && /^(p|div)$/i.test(node.tagName)) {
      yield null
      pending.push(null)
      pushChildren(node)
    } else {
      yield node
    }
  }
}

function hasParagraphCodeBlock(element: Element): boolean {
  for (const node of paragraphCodeNodes(element)) {
    if (node instanceof Element && node.tagName.toLowerCase() === 'pre') {
      return true
    }
  }
  return false
}

// WebKit 26.4/Chromium 147 insertUnorderedList nests ul inside p; serialize surrounding inline runs and list as separate blocks or typed list markers vanish. Leave DOM unchanged.
function blocksAroundLists(element: Element, preserveCode = false): string {
  const blocks: string[] = []
  let inline = ''
  const flushInline = () => {
    if (inline.trim()) {
      blocks.push(inline.trim())
    }
    inline = ''
  }
  const containsLists = !preserveCode || holdsUnownedList(element)
  const nodes = preserveCode ? paragraphCodeNodes(element) : Array.from(element.childNodes)
  for (const child of nodes) {
    if (child === null) {
      flushInline()
      continue
    }
    if (!(child instanceof Element)) {
      inline += inlineMarkdown(child)
      continue
    }
    const tag = child.tagName.toLowerCase()
    if (preserveCode && tag === 'pre') {
      flushInline()
      blocks.push(blockMarkdown(child))
      continue
    }
    if (tag === 'ul' || tag === 'ol') {
      flushInline()
      blocks.push(listMarkdown(child, 0))
      continue
    }
    if (containsLists && holdsUnownedList(child)) {
      flushInline()
      blocks.push(blocksAroundLists(child))
      continue
    }
    inline += inlineMarkdown(child)
  }
  flushInline()
  return blocks.filter(Boolean).join('\n\n')
}

// Unknown block elements serialize inline content so browser-created tags cannot lose user text.
export function blockMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return textContent(node).trim()
  }
  if (!(node instanceof Element)) {
    return ''
  }
  const tag = node.tagName.toLowerCase()
  if (/^h[1-6]$/.test(tag)) {
    return `${'#'.repeat(Number(tag.slice(1)))} ${inlineChildren(node).trim()}`
  }
  if (tag === 'p' || tag === 'div') {
    if (node.querySelector('pre') && hasParagraphCodeBlock(node)) {
      return blocksAroundLists(node, true)
    }
    return holdsUnownedList(node) ? blocksAroundLists(node) : inlineChildren(node).trim()
  }
  if (tag === 'blockquote') {
    return inlineChildren(node)
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
  }
  if (tag === 'pre') {
    const language = node.getAttribute('data-language') ?? ''
    const code = literalTextContent(node)
    const fence = codeFenceFor(code)
    return `${fence}${language}\n${code}\n${fence}`
  }
  if (tag === 'ul' || tag === 'ol') {
    return listMarkdown(node, 0)
  }
  if (tag === 'table') {
    const rows = Array.from(node.querySelectorAll('tr'))
    if (rows.length === 0) {
      return ''
    }
    const cellsFor = (row: Element) =>
      Array.from(row.children).map((cell) => escapeTableCell(inlineChildren(cell).trim()))
    const headers = cellsFor(rows[0]!)
    const bodyRows = rows.slice(1).map(cellsFor)
    const separator = headers.map(() => '---').join(' | ')
    const body = bodyRows.length
      ? `\n${bodyRows.map((row) => `| ${row.join(' | ')} |`).join('\n')}`
      : ''
    return `| ${headers.join(' | ')} |\n| ${separator} |${body}`
  }
  if (tag === 'hr') {
    return '---'
  }
  if (tag === 'img') {
    return inlineMarkdown(node)
  }
  return inlineChildren(node).trim()
}
