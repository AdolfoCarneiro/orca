import type { RichMarkdownImagePasteArgs } from './rich-markdown-paste-image'
import { handleRichMarkdownHtmlImageImport } from './rich-markdown-html-image-import'

export function handleRichMarkdownHtmlImagePaste(args: RichMarkdownImagePasteArgs): boolean {
  return handleRichMarkdownHtmlImageImport({
    ...args,
    html: args.event.clipboardData?.getData('text/html') ?? ''
  })
}
