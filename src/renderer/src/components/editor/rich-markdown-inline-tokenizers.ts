import { getExtensionField } from '@tiptap/core'
import { InlineMath } from '@tiptap/extension-mathematics'
import StarterKit from '@tiptap/starter-kit'
import { createMarkdownTokenizerStart } from './markdown-tokenizer-start'

export const RichMarkdownInlineMath = InlineMath.extend({
  markdownTokenizer:
    InlineMath.config.markdownTokenizer && typeof InlineMath.config.markdownTokenizer !== 'function'
      ? {
          ...InlineMath.config.markdownTokenizer,
          start: createMarkdownTokenizerStart('$')
        }
      : InlineMath.config.markdownTokenizer
})

export const RichMarkdownStarterKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((extension) => {
      if (extension.name !== 'underline') {
        return extension
      }
      const tokenizer = getExtensionField(extension, 'markdownTokenizer')
      if (!tokenizer || typeof tokenizer === 'function') {
        return extension
      }
      return extension.extend({
        markdownTokenizer: {
          ...tokenizer,
          start: createMarkdownTokenizerStart('++')
        }
      })
    })
  }
})
