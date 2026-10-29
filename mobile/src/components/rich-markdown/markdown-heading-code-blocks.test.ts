// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

const stopDocuments: (() => void)[] = []

afterEach(() => {
  stopDocuments.splice(0).forEach((stop) => stop())
  document.body.innerHTML = ''
})

function codeBlock(text: string, language = '') {
  const pre = document.createElement('pre')
  pre.setAttribute('data-language', language)
  pre.append(text)
  return pre
}

function saveHeading(heading: Element, markdown: string, codes: string[]) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editorDocument = createRichMarkdownEditorDocument({
    ...quietRichMarkdownEditorHost(),
    postToHost: (message) => messages.push(message)
  })
  stopDocuments.push(editorDocument.stop)
  editorDocument.send.setMarkdown('seed', 7)
  const surface = document.getElementById('editor')
  if (!surface) {
    throw new Error('Missing editor')
  }
  surface.replaceChildren(heading)
  const live = surface.innerHTML
  surface.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  expect(surface.innerHTML).toBe(live)
  expect(messages.filter((message) => message.type === 'change')).toEqual([
    { type: 'change', generation: 7, markdown }
  ])
  for (const generation of [8, 9]) {
    editorDocument.send.setMarkdown(markdown, generation)
    expect(Array.from(surface.querySelectorAll('pre')).map((node) => node.textContent)).toEqual(
      codes
    )
    expect(editorDocument.send.currentMarkdown()).toBe(markdown)
  }
  return surface
}

it.each([1, 2, 3, 4, 5, 6])(
  'retains selected code and trailing heading text at level %i',
  (level) => {
    const heading = document.createElement(`h${level}`)
    heading.append(codeBlock('First'), 'Second')

    const surface = saveHeading(heading, `\`\`\`\nFirst\n\`\`\`\n\n${'#'.repeat(level)} Second`, [
      'First'
    ])
    expect(surface.querySelector(`h${level}`)?.textContent).toBe('Second')
  }
)

it('keeps literal marker text and inline marks around multiple direct code blocks', () => {
  const heading = document.createElement('h2')
  const before = document.createElement('strong')
  before.append('Before')
  const fragmented = document.createElement('span')
  fragmented.append('br ')
  heading.append(before, codeBlock('One'), 'Literal <', fragmented, '/> text', codeBlock('Two'))

  const surface = saveHeading(
    heading,
    '## **Before**\n\n```\nOne\n```\n\n## Literal <br /> text\n\n```\nTwo\n```',
    ['One', 'Two']
  )
  expect(Array.from(surface.querySelectorAll('h2')).map((node) => node.textContent)).toEqual([
    'Before',
    'Literal <br /> text'
  ])
  expect(surface.querySelector('h2 strong')?.textContent).toBe('Before')
  expect(surface.querySelectorAll('h2 br').length).toBe(0)
})

it('keeps code-only headings literal without creating an empty heading', () => {
  const heading = document.createElement('h3')
  heading.append(codeBlock('  one\u00a0&amp;\n```\n', 'ts'), codeBlock(''))

  const surface = saveHeading(heading, '````ts\n  one\u00a0&amp;\n```\n\n````\n\n```\n\n```', [
    '  one\u00a0&amp;\n```\n',
    ''
  ])
  expect(surface.querySelectorAll('h1,h2,h3,h4,h5,h6').length).toBe(0)
  expect(surface.querySelector('pre')?.getAttribute('data-language')).toBe('ts')
})
