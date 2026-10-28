import { codeFenceFor } from './markdown-code-fence'

export function literalTextContent(node: Node): string {
  return node.textContent ?? ''
}

/** A node's prose with browser-created non-breaking spaces turned back into spaces. */
export function textContent(node: Node): string {
  return literalTextContent(node).replace(/ /g, ' ')
}

// Serialize task label as empty: checkbox chrome is replaced by list writer’s Markdown marker.
export function inlineMarkdown(node: Node | null | undefined): string {
  if (!node) {
    return ''
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return textContent(node)
  }
  if (!(node instanceof Element)) {
    return ''
  }
  const tag = node.tagName.toLowerCase()
  if (tag === 'br') {
    return '\n'
  }
  if (tag === 'strong' || tag === 'b') {
    return `**${inlineChildren(node)}**`
  }
  if (tag === 'em' || tag === 'i') {
    return `*${inlineChildren(node)}*`
  }
  if (tag === 's' || tag === 'del' || tag === 'strike') {
    return `~~${inlineChildren(node)}~~`
  }
  if (tag === 'code' && node.parentElement && node.parentElement.tagName.toLowerCase() !== 'pre') {
    const code = literalTextContent(node)
    if (!code) {
      return ''
    }
    const delimiter = codeFenceFor(code, 1)
    const padding =
      code.startsWith('`') ||
      code.endsWith('`') ||
      (code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code))
        ? ' '
        : ''
    return `${delimiter}${padding}${code}${padding}${delimiter}`
  }
  if (tag === 'a') {
    return `[${inlineChildren(node)}](${node.getAttribute('href') ?? ''})`
  }
  if (tag === 'img') {
    return `![${node.getAttribute('alt') ?? ''}](${node.getAttribute('src') ?? ''})`
  }
  if (tag === 'label') {
    return ''
  }
  return inlineChildren(node)
}

export function inlineChildren(element: Element): string {
  return Array.from(element.childNodes)
    .map((child) => inlineMarkdown(child))
    .join('')
}
