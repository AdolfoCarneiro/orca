// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatTextAttachments } from './NativeChatTextAttachments'
import { NativeChatMarkdown } from './NativeChatMarkdown'
vi.mock('./NativeChatInlineVisual', () => ({ NativeChatInlineVisual: () => null }))
vi.mock('./native-chat-image-runtime-context', () => ({
  useNativeChatImageRuntimeContext: () => null
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  isLocalizedRuntimeError: () => false
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('./native-chat-visual-markdown-extension', () => ({
  useNativeChatVisualMarkdownExtension: () => undefined
}))
vi.mock('./use-native-chat-file-link-existence', () => ({
  useNativeChatFileLinkExists: () => undefined
}))
vi.mock('./NativeChatMarkdownImage', async () => ({
  NativeChatMarkdownImage: () => null,
  NativeChatMarkdownImageLinkContext: (await import('react')).createContext(undefined)
}))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
afterEach(cleanup)
const path =
  '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/orca-paste-123-abc.txt'
const renderText = (content: string) =>
  createElement(NativeChatMarkdown, { rowKey: 'architecture35636', content, variant: 'document' })
it('preserves fenced and inline literals and whole-document formatting around an actionable reference', () => {
  const content = [
    'Literal:\n\n```text\n@',
    path,
    '\nKEEP THIS CODE\n```\n\nOUTSIDE CODE\n\n`@',
    path,
    '`\n\n**Read @',
    path,
    ' then stop**'
  ].join('')
  const view = render(
    createElement(NativeChatTextAttachments, { content, structured: true, renderText })
  )
  const code = [...view.container.querySelectorAll('pre')].map((node) => node.textContent).join('|')
  expect(code).toContain(`@${path}`)
  expect(code).toContain('KEEP THIS CODE')
  expect(code).not.toContain('OUTSIDE CODE')
  expect(view.container.querySelector('strong')?.textContent).toBe(`Read @${path} then stop`)
  expect(view.container.querySelectorAll('button')).toHaveLength(1)
  view.rerender(
    createElement(NativeChatTextAttachments, {
      content: ['```text\n@', path, '\n```\n\n`@', path, '`'].join(''),
      structured: true,
      renderText
    })
  )
  expect(view.container.querySelectorAll('button')).toHaveLength(0)
})

it('recognizes only changed rows at N and 10N without reading attachment bodies before open', async () => {
  const references = await import('../../../../shared/native-chat-text-attachment-references')
  const recognize = vi.spyOn(references, 'nativeChatTextAttachmentPaths')
  const renderText = (text: string) => createElement('span', null, text)
  for (const count of [10, 100]) {
    let rows = Array.from(
      { length: count },
      (_, index) => `row ${index} **Read @${path} then stop** ${'prose '.repeat(100)}`
    )
    const ui = () =>
      rows.map((content, index) =>
        createElement(NativeChatTextAttachments, {
          key: index,
          content,
          structured: true,
          renderText
        })
      )
    recognize.mockClear()
    const view = render(ui())
    expect(recognize).toHaveBeenCalledTimes(count)
    recognize.mockClear()
    for (let update = 0; update < 3; update++) {
      view.rerender(ui())
    }
    expect(recognize).not.toHaveBeenCalled()
    rows = rows.map((content, index) => (index === 0 ? `${content}changed` : content))
    view.rerender(ui())
    expect(recognize).toHaveBeenCalledTimes(1)
    view.unmount()
  }
  expect(rpc).not.toHaveBeenCalled()
  recognize.mockRestore()
})
