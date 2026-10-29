import { hasBinaryFileExtension } from './binary-file-extensions'
import { AGENT_SESSION_ATTACHMENTS_DIR_NAME } from './agent-session-attachments'

export function isCommittedChatAttachmentCandidate(path: string): boolean {
  return (
    !hasBinaryFileExtension(path) &&
    /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) &&
    new RegExp(
      `(?:^|[\\\\/])${AGENT_SESSION_ATTACHMENTS_DIR_NAME}[\\\\/][0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}[\\\\/][^\\\\/]+$`,
      'i'
    ).test(path) &&
    path.split(/[\\/]/).at(-1) !== '.upload.part'
  )
}

export type ChatAttachmentPart = { text: string; path?: string }
/** Scan only the rendered row, preserving the exact stored representation and surrounding text. */
export function nativeChatTextAttachmentParts(
  text: string,
  structured: boolean
): ChatAttachmentPart[] {
  if (!structured) {
    return [{ text }]
  }
  const parts: ChatAttachmentPart[] = []
  const pattern = /@"(?:\\"|[^"])*"|@'[^']*'|@[^\s]+/g
  let end = 0
  for (const match of text.matchAll(pattern)) {
    const token = match[0]
    if (token.length > 8192 || (match.index > 0 && !/\s/.test(text[match.index - 1]!))) {
      continue
    }
    const quoted = token[1] === '"' || token[1] === "'"
    const path = quoted
      ? token[1] === '"'
        ? token.slice(2, -1).replace(/\\"/g, '"')
        : token.slice(2, -1)
      : token.slice(1)
    if (!isCommittedChatAttachmentCandidate(path)) {
      continue
    }
    if (match.index > end) {
      parts.push({ text: text.slice(end, match.index) })
    }
    parts.push({ text: token, path })
    end = match.index + token.length
  }
  if (end < text.length) {
    parts.push({ text: text.slice(end) })
  }
  return parts.length ? parts : [{ text }]
}

export function chatTextAttachmentName(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? path
  return /^orca-paste-.*\.txt$/.test(name) ? 'Pasted text' : name
}

type AttachmentMarkdownNode = {
  type: string
  value?: string
  children?: readonly AttachmentMarkdownNode[]
}

/** Attachment actions follow parsed prose; literal code remains an ordinary part of the document. */
export function nativeChatTextAttachmentPaths(tree: AttachmentMarkdownNode): string[] {
  const paths = new Set<string>()
  const visit = (node: typeof tree) => {
    if (node.type === 'text' && node.value) {
      for (const part of nativeChatTextAttachmentParts(node.value, true)) {
        if (part.path) {
          paths.add(part.path)
        }
      }
    } else if (node.type !== 'code' && node.type !== 'inlineCode') {
      node.children?.forEach(visit)
    }
  }
  visit(tree)
  return [...paths]
}
