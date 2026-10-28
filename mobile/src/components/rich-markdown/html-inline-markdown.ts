import { escapeMarkdownText } from './markdown-escaping'

/** A node's text with non-breaking spaces turned back into the spaces the source wrote. */
export function textContent(node: Node): string {
  return (node.textContent ?? '').replace(/ /g, ' ')
}

function endsWithLineBreak(root: Node): boolean {
  let node: Node | null = root
  let whitespace: { parent: ParentNode | null; endsWithBreak: boolean } | undefined
  while (node) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      const endsWithBreak = /[\r\n]$/.test(node.textContent)
      if (/^[ \t\r\n]+$/.test(node.textContent) && node !== root) {
        whitespace ??= { parent: node.parentNode, endsWithBreak }
      } else {
        return whitespace?.endsWithBreak ?? endsWithBreak
      }
    }
    if (node instanceof Element) {
      const tag = node.tagName.toLowerCase()
      if ((tag === 'p' || tag === 'div') && whitespace?.parent === node.parentNode) {
        whitespace = undefined
      }
      if (tag === 'br') {
        return whitespace?.endsWithBreak ?? true
      }
      if (tag === 'img' || (tag === 'code' && node.textContent)) {
        return whitespace?.endsWithBreak ?? false
      }
      if (tag !== 'label' && node.lastChild) {
        node = node.lastChild
        continue
      }
    }
    while (node && node !== root && !node.previousSibling) {
      node = node.parentNode
    }
    if (!node || node === root) {
      break
    }
    node = node.previousSibling
  }
  return whitespace?.endsWithBreak ?? false
}

// Serialize task label as empty: checkbox chrome is replaced by list writer’s Markdown marker.
export function inlineMarkdown(
  node: Node | null | undefined,
  lineBreak = '\n',
  blockLineBreaks = false
): string {
  if (!node) {
    return ''
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const markdown = escapeMarkdownText(textContent(node))
    return lineBreak === '\n' ? markdown : markdown.replace(/\r\n?|\n/g, lineBreak)
  }
  if (!(node instanceof Element)) {
    return ''
  }
  let tag = node.tagName.toLowerCase()
  while (
    blockLineBreaks &&
    (tag === 'p' || tag === 'div' || tag === 'span') &&
    node.childNodes.length === 1
  ) {
    node = node.firstChild
    if (!(node instanceof Element)) {
      return inlineMarkdown(node, lineBreak, blockLineBreaks)
    }
    tag = node.tagName.toLowerCase()
  }
  if (tag === 'br') {
    return lineBreak
  }
  if (tag === 'strong' || tag === 'b') {
    return `**${inlineChildren(node, lineBreak, blockLineBreaks)}**`
  }
  if (tag === 'em' || tag === 'i') {
    return `*${inlineChildren(node, lineBreak, blockLineBreaks)}*`
  }
  if (tag === 's' || tag === 'del' || tag === 'strike') {
    return `~~${inlineChildren(node, lineBreak, blockLineBreaks)}~~`
  }
  if (tag === 'code' && node.parentElement && node.parentElement.tagName.toLowerCase() !== 'pre') {
    return `\`${textContent(node)}\``
  }
  if (tag === 'a') {
    return `[${inlineChildren(node, lineBreak, blockLineBreaks)}](${node.getAttribute('href') ?? ''})`
  }
  if (tag === 'img') {
    return `![${node.getAttribute('alt') ?? ''}](${node.getAttribute('src') ?? ''})`
  }
  if (tag === 'label') {
    return ''
  }
  return inlineChildren(node, lineBreak, blockLineBreaks)
}

export function inlineChildren(
  element: Element,
  lineBreak = '\n',
  blockLineBreaks = false
): string {
  const parts: string[] = []
  let previous: Node | undefined
  let previousBlock = false
  let whitespace = ''
  for (const child of element.childNodes) {
    if (
      blockLineBreaks &&
      child.nodeType === Node.TEXT_NODE &&
      /^[ \t\r\n]+$/.test(child.textContent ?? '')
    ) {
      whitespace += inlineMarkdown(child, lineBreak)
      continue
    }
    const markdown = inlineMarkdown(child, lineBreak, blockLineBreaks)
    if (!markdown) {
      continue
    }
    const block = blockLineBreaks && child instanceof Element && /^(p|div)$/i.test(child.tagName)
    if (previous && (block || previousBlock) && !endsWithLineBreak(previous)) {
      parts.push(lineBreak)
    }
    if (whitespace && !block && !previousBlock) {
      parts.push(whitespace)
    }
    whitespace = ''
    parts.push(markdown)
    previous = child
    previousBlock = block
  }
  if (whitespace && !previousBlock) {
    parts.push(whitespace)
  }
  return parts.join('')
}
