import { codeFenceFor } from './markdown-code-fence'

export function literalTextContent(node: Node): string {
  return node.textContent ?? ''
}

/** A node's prose with browser-created non-breaking spaces turned back into spaces. */
export function textContent(node: Node): string {
  return literalTextContent(node).replace(/ /g, ' ')
}

function codeMarkdown(code: string): string {
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

function isInlineCode(node: Node): boolean {
  return (
    node instanceof Element &&
    node.tagName.toLowerCase() === 'code' &&
    node.parentElement !== null &&
    node.parentElement.tagName.toLowerCase() !== 'pre'
  )
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
  if (isInlineCode(node)) {
    return codeMarkdown(literalTextContent(node))
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
  return inlineNodesMarkdown(element.childNodes)
}

export function inlineNodesMarkdown(nodes: Iterable<Node>): string {
  const parts: string[] = []
  let code = ''
  for (const child of nodes) {
    if (isInlineCode(child)) {
      code += literalTextContent(child)
      continue
    }
    const markdown = inlineMarkdown(child)
    if (!markdown) {
      continue
    }
    if (code) {
      parts.push(codeMarkdown(code))
      code = ''
    }
    parts.push(markdown)
  }
  if (code) {
    parts.push(codeMarkdown(code))
  }
  return parts.join('')
}
