// @vitest-environment happy-dom
import { Editor, type JSONContent } from '@tiptap/core'
import { isAllowedUri } from '@tiptap/extension-link'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Markdown } from '@tiptap/markdown'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { setRuntimeEnvironmentConnectionGenerationForTests } from '@/store/slices/runtime-status'
import { RichMarkdownClipboardOrigin } from './rich-markdown-clipboard-origin'
import {
  setRichMarkdownImageResolverContext,
  type RichMarkdownImageRuntimeContext
} from './rich-markdown-image-context'
import { resolveMarkdownPreviewHref } from './markdown-preview-links'

const ssh = vi.hoisted(() => ({ generation: 1 }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      sshConnectionStates: new Map([
        ['source', { connectionGeneration: ssh.generation }],
        ['other', { connectionGeneration: 1 }]
      ])
    })
  }
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))

const editors: Editor[] = []
function createEditor(
  filePath: string,
  href = './guide.md',
  runtimeContext?: RichMarkdownImageRuntimeContext | null
): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        link: { isAllowedUri: (url) => Boolean(isAllowedUri(url, ['file'])) }
      }),
      Image.configure({ inline: true }),
      RichMarkdownClipboardOrigin,
      Markdown
    ],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Before ' },
            {
              type: 'text',
              text: 'guide',
              marks: [{ type: 'link', attrs: { href, title: 'Reference' } }, { type: 'bold' }]
            },
            { type: 'text', text: ' after.' }
          ]
        }
      ]
    }
  })
  editors.push(editor)
  setRichMarkdownImageResolverContext(editor, { filePath, runtimeContext })
  return editor
}
function copy(editor: Editor): string {
  editor.commands.selectAll()
  return editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML
}
function paste(editor: Editor, html: string): void {
  editor.commands.selectAll()
  editor.view.pasteHTML(html)
}
function href(editor: Editor): string | null {
  return editor.view.dom.querySelector('a')?.getAttribute('href') ?? null
}
function environment(id: string): RichMarkdownImageRuntimeContext {
  return {
    target: { kind: 'environment', environmentId: id },
    worktreeId: 'folder:notes',
    worktreePath: '/repo'
  }
}
function directSsh(id: string): RichMarkdownImageRuntimeContext {
  return {
    target: { kind: 'local' },
    connectionId: id,
    expectedExternalSshTargetId: id,
    worktreeId: 'folder:notes',
    worktreePath: '/repo'
  }
}
beforeEach(() => {
  ssh.generation = 1
  replaceRuntimeEnvironmentRevisions(
    ['source', 'other'].map((id) => ({ id, pairingRevision: 1, createdAt: 1 }))
  )
  for (const id of ['source', 'other']) {
    setRuntimeEnvironmentConnectionGenerationForTests(id, 0)
  }
})
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

it('keeps a closed source link target, formatting and one-step undo through Markdown reopen', () => {
  const source = createEditor('/repo/notes/note.md')
  const original = source.getMarkdown()
  const html = copy(source)
  expect(html).toContain('href="file:///repo/notes/guide.md"')
  expect(html).toContain('data-orca-link-clipboard-href="./guide.md"')
  expect(html).toContain('data-orca-link-clipboard-origin=')
  expect(source.getMarkdown()).toBe(original)
  source.destroy()
  const target = createEditor('/repo/other/note.md', 'https://example.com')
  const before = target.getJSON()
  paste(target, html)
  expect(href(target)).toBe('../notes/guide.md')
  expect(target.view.dom.querySelector('a strong, strong a')?.textContent).toBe('guide')
  expect(target.view.dom.querySelector('a')?.getAttribute('title')).toBe('Reference')
  const markdown = target.getMarkdown()
  expect(markdown).not.toContain('clipboard-origin')
  const reopened = createEditor('/repo/other/note.md')
  reopened.commands.setContent(markdown, { contentType: 'markdown' })
  expect(href(reopened)).toBe('../notes/guide.md')
  expect(resolveMarkdownPreviewHref(href(reopened) ?? '', '/repo/other/note.md')?.pathname).toBe(
    '/repo/notes/guide.md'
  )
  expect(target.commands.undo()).toBe(true)
  expect(target.getJSON()).toEqual(before)
})

it.each(['/repo/notes/second.md', '/repo/notes/note.md'])(
  'keeps the relative spelling when pasted into %s',
  (path) => {
    const source = createEditor('/repo/notes/note.md')
    const target = path.endsWith('/note.md') ? source : createEditor(path)
    paste(target, copy(source))
    expect(href(target)).toBe('./guide.md')
  }
)

it.each([
  [
    '/repo/notes/note.md',
    '/repo/other/note.md',
    './a%20b%23c.md?version=2#part',
    '../notes/a%20b%23c.md?version=2#part'
  ],
  ['/repo/notes/note.md', '/repo/other/note.md', '../guide.md', '../guide.md'],
  [
    '/repo/notes/note.md',
    '/repo/other/note.md',
    './Caf%C3%A9.md#section',
    '../notes/Caf%C3%A9.md#section'
  ],
  ['C:\\repo\\notes\\note.md', 'C:\\repo\\other\\note.md', './guide.md', '../notes/guide.md'],
  [
    '\\\\server\\share\\repo\\notes\\note.md',
    '\\\\server\\share\\repo\\other\\note.md',
    './guide.md',
    '../notes/guide.md'
  ],
  ['/repo/notes/note.md', '/repo/notes/sub/note.md', './dir/', '../dir/']
])('preserves the resolved target from %s into %s for %s', (from, to, link, expected) => {
  const source = createEditor(from, link)
  const target = createEditor(to)
  paste(target, copy(source))
  expect(href(target)).toBe(expected)
  expect(resolveMarkdownPreviewHref(href(target) ?? '', to)?.toString()).toBe(
    resolveMarkdownPreviewHref(link, from)?.toString()
  )
})

it.each([
  ['C:\\repo\\notes\\note.md', 'D:\\repo\\other\\note.md', 'file:///C:/repo/notes/guide.md'],
  ['\\\\server\\first\\note.md', '\\\\server\\second\\note.md', 'file://server/first/guide.md']
])('preserves the target across filesystem roots %s and %s', (from, to, expected) => {
  const source = createEditor(from)
  const target = createEditor(to)
  paste(target, copy(source))
  expect(href(target)).toBe(expected)
  expect(resolveMarkdownPreviewHref(href(target) ?? '', to)?.toString()).toBe(
    resolveMarkdownPreviewHref('./guide.md', from)?.toString()
  )
})

it.each([
  ['https://example.com/guide', 'https://example.com/guide'],
  ['mailto:author@example.com', 'mailto:author@example.com'],
  ['#section', '#section'],
  ['/guide.md', '/guide.md'],
  ['file:///repo/guide.md', 'file:///repo/guide.md']
])('keeps ordinary handling for a nonrelative link %s', (link, expected) => {
  const source = createEditor('/repo/notes/note.md', link)
  const html = copy(source)
  expect(html).not.toContain('data-orca-link-clipboard-origin=')
  const target = createEditor('/repo/other/note.md')
  paste(target, html)
  expect(href(target)).toBe(expected)
})

it.each(['missing', 'unknown', 'altered'])(
  'keeps ordinary paste behavior for %s origin metadata',
  (kind) => {
    const source = createEditor('/repo/notes/note.md')
    let html = copy(source)
    if (kind === 'missing') {
      html = html.replace(/ data-orca-link-clipboard-origin="[^"]+"/g, '')
    }
    if (kind === 'unknown') {
      html = html.replace(
        /data-orca-link-clipboard-origin="[^"]+"/g,
        'data-orca-link-clipboard-origin="unknown"'
      )
    }
    if (kind === 'altered') {
      html = html.replace('href="file:///repo/notes/guide.md"', 'href="./different.md"')
    }
    const target = createEditor('/repo/other/note.md')
    paste(target, html)
    expect(href(target)).toBe(kind === 'altered' ? './different.md' : 'file:///repo/notes/guide.md')
  }
)

it.each(['local', 'environment', 'ssh'] as const)(
  'rebases links within the same %s owner',
  (kind) => {
    const owner =
      kind === 'environment'
        ? environment('source')
        : kind === 'ssh'
          ? directSsh('source')
          : undefined
    const source = createEditor('/repo/notes/note.md', './guide.md', owner)
    const target = createEditor('/repo/other/note.md', './old.md', owner)
    paste(target, copy(source))
    expect(href(target)).toBe('../notes/guide.md')
  }
)

it.each(['local-to-environment', 'other-environment', 'other-ssh', 'ssh-to-local', 'unresolved'])(
  'keeps ordinary link behavior across %s owners',
  (kind) => {
    const sourceOwner =
      kind === 'other-environment'
        ? environment('source')
        : kind.startsWith('other-ssh') || kind === 'ssh-to-local'
          ? directSsh('source')
          : undefined
    const targetOwner =
      kind === 'unresolved'
        ? null
        : kind === 'other-ssh'
          ? directSsh('other')
          : kind === 'ssh-to-local'
            ? undefined
            : environment('other')
    const source = createEditor('/repo/notes/note.md', './guide.md', sourceOwner)
    const target = createEditor('/repo/other/note.md', './old.md', targetOwner)
    paste(target, copy(source))
    expect(href(target)).toBe('./guide.md')
  }
)

it.each(['pairing', 'connection', 'ssh'] as const)('ignores stale %s origin metadata', (kind) => {
  const owner = kind === 'ssh' ? directSsh('source') : environment('source')
  const source = createEditor('/repo/notes/note.md', './guide.md', owner)
  const html = copy(source)
  if (kind === 'pairing') {
    replaceRuntimeEnvironmentRevisions([{ id: 'source', pairingRevision: 2, createdAt: 1 }], {
      retired: ['source'],
      sameHost: []
    })
  }
  if (kind === 'connection') {
    setRuntimeEnvironmentConnectionGenerationForTests('source', 1)
  }
  if (kind === 'ssh') {
    ssh.generation++
  }
  const target = createEditor('/repo/other/note.md', './old.md', owner)
  paste(target, html)
  expect(href(target)).toBe('./guide.md')
})

it('keeps a newer clipboard usable after old origin eviction', () => {
  const source = createEditor('/repo/notes/note.md')
  const oldest = copy(source)
  let newest = ''
  for (let copyIndex = 0; copyIndex < 16; copyIndex++) {
    newest = copy(source)
  }
  const target = createEditor('/repo/other/note.md')
  paste(target, oldest)
  expect(href(target)).toBe('file:///repo/notes/guide.md')
  paste(target, newest)
  expect(href(target)).toBe('../notes/guide.md')
})

it('invalidates the whole origin when its path budget overflows', () => {
  const source = createEditor('/repo/notes/note.md')
  const content: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: ['./guide.md', `./${'x'.repeat(33 * 1024)}.md`].map((href) => ({
          type: 'text',
          text: href === './guide.md' ? 'first ' : 'second',
          marks: [{ type: 'link', attrs: { href } }]
        }))
      }
    ]
  }
  source.commands.setContent(content)
  const target = createEditor('/repo/other/note.md')
  paste(target, copy(source))
  expect(href(target)).toBe('file:///repo/notes/guide.md')
})

it.each([
  [
    '/repo/notes/note.md',
    './a%20b%23c.md?version=2#part',
    'file:///repo/notes/a%20b%23c.md?version=2#part'
  ],
  ['C:\\repo\\notes\\note.md', './guide.md', 'file:///C:/repo/notes/guide.md'],
  ['\\\\server\\share\\notes\\note.md', './guide.md', 'file://server/share/notes/guide.md']
])(
  'keeps exported local links from %s usable without any Orca clipboard attributes',
  (path, link, expected) => {
    const source = createEditor(path, link)
    const original = source.getMarkdown()
    const html = copy(source).replace(/ data-orca-[^=]+="[^"]*"/g, '')
    source.destroy()
    const target = createEditor('/repo/other/note.md')
    paste(target, html)
    expect(href(target)).toBe(expected)
    expect(target.getMarkdown()).not.toContain('data-orca')
    const reopened = createEditor('/repo/other/note.md')
    reopened.commands.setContent(target.getMarkdown(), { contentType: 'markdown' })
    expect(href(reopened)).toBe(expected)
    expect(original).toContain(link)
  }
)

it.each(['environment', 'ssh'] as const)('keeps %s exports relative', (kind) => {
  const owner = kind === 'environment' ? environment('source') : directSsh('source')
  const source = createEditor('/repo/notes/note.md', './guide.md', owner)
  const html = copy(source)
  expect(html).toContain('href="./guide.md"')
  expect(html).not.toContain('data-orca-link-clipboard-href=')
})

it.each(['environment', 'ssh', 'unresolved'] as const)(
  'keeps inherited local-to-%s handling without a source origin',
  (kind) => {
    const source = createEditor('/repo/notes/note.md')
    const html = copy(source).replace(/ data-orca-link-clipboard-origin="[^"]+"/g, '')
    const owner =
      kind === 'environment' ? environment('source') : kind === 'ssh' ? directSsh('source') : null
    const target = createEditor('/repo/other/note.md', './old.md', owner)
    paste(target, html)
    expect(href(target)).toBe('./guide.md')
  }
)

it('keeps every local link portable when the origin reference budget overflows', () => {
  const source = createEditor('/repo/notes/note.md')
  source.commands.setContent({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: Array.from({ length: 260 }, (_, index) => ({
          type: 'text',
          text: `guide ${index} `,
          marks: [{ type: 'link', attrs: { href: `./guide-${index}.md` } }]
        }))
      }
    ]
  })
  const target = createEditor('/repo/other/note.md')
  paste(target, copy(source))
  const links = Array.from(target.view.dom.querySelectorAll('a'))
  expect(links).toHaveLength(260)
  expect(links.map((link) => link.getAttribute('href'))).toEqual(
    Array.from({ length: 260 }, (_, index) => `file:///repo/notes/guide-${index}.md`)
  )
})

it('preserves each original spelling when equivalent links return to their source folder', () => {
  const source = createEditor('/repo/notes/note.md')
  source.commands.setContent({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: ['./guide.md', 'guide.md', '../notes/guide.md'].map((href, index) => ({
          type: 'text',
          text: `guide ${index} `,
          marks: [{ type: 'link', attrs: { href } }]
        }))
      }
    ]
  })
  const target = createEditor('/repo/notes/other.md')
  paste(target, copy(source))
  expect(
    Array.from(target.view.dom.querySelectorAll('a')).map((link) => link.getAttribute('href'))
  ).toEqual(['./guide.md', 'guide.md', '../notes/guide.md'])
})
