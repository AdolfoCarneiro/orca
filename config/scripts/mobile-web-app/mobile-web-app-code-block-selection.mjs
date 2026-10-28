import { expect, it } from 'vitest'

// WebKit can report a Mac user agent while running on Linux.
const historyModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function verifyCodeBlockSelections({
  browser,
  openPage,
  setContent,
  select,
  press,
  readSurface
}) {
  const cases = [
    { markdown: 'selected text', html: '<p>selected text</p>', literal: 'selected text' },
    { markdown: 'first\nsecond', html: '<p>first<br>second</p>', literal: 'first\nsecond' },
    {
      markdown: 'first\n\nsecond',
      html: '<p>first</p>\n<p>second</p>',
      literal: 'first\nsecond'
    },
    {
      markdown: '**bold** and *italic*',
      html: '<p><strong>bold</strong> and <em>italic</em></p>',
      literal: 'bold and italic'
    },
    {
      markdown: '```ts\nfirst\nsecond\n```',
      html: '<pre data-language="ts"><code>first\nsecond</code></pre>',
      literal: 'first\nsecond',
      language: 'ts'
    },
    {
      markdown: 'Prefix first\n\nMiddle text\n\nlast suffix',
      html: '<p>Prefix first</p>\n<p>Middle text</p>\n<p>last suffix</p>',
      literal: 'Prefix first\nMiddle text\nlast suffix',
      partial: true
    },
    {
      markdown: 'Before\n\nAfter',
      html: '<p>Before</p>\n<p>After</p>',
      literal: 'code',
      collapsed: true,
      saved: 'Before\n\n```\ncode\n```\n\nAfter'
    },
    {
      markdown: 'Before\n\nSelected text\n\n- after',
      html: '<p>Before</p>\n<p>Selected text</p>\n<ul><li><p>after</p></li></ul>',
      literal: 'Selected text',
      paragraph: true,
      saved: 'Before\n\n```\nSelected text\n```\n\n- after'
    }
  ]
  for (const sample of cases) {
    const { page, consoleErrors } = await openPage(browser)
    try {
      await setContent(page, sample.markdown, sample.html)
      await (sample.partial || sample.collapsed || sample.paragraph
        ? page.evaluate(
            ({ partial, paragraph }) => {
              const editor = document.querySelector('#first-surface #editor')
              const paragraphs = editor.querySelectorAll('p')
              editor.focus()
              const range = document.createRange()
              if (partial) {
                range.setStart(paragraphs[0].firstChild, 7)
                range.setEnd(paragraphs[2].firstChild, 4)
              } else if (paragraph) {
                range.selectNodeContents(paragraphs[1])
              } else {
                range.setStart(paragraphs[1].firstChild, 0)
                range.collapse(true)
              }
              window.getSelection().removeAllRanges()
              window.getSelection().addRange(range)
            },
            { partial: sample.partial === true, paragraph: sample.paragraph === true }
          )
        : select(page, 'all'))
      const selected = await page.evaluate(() => window.getSelection().toString())
      await press(page, 'Code block')
      const saved = sample.saved ?? `\`\`\`${sample.language ?? ''}\n${sample.literal}\n\`\`\``
      await expect
        .poll(() => page.evaluate(() => globalThis.__orcaEditor.changes.at(-1)))
        .toBe(saved)
      await page.keyboard.press(`${historyModifier}+z`)
      await expect.poll(() => readSurface(page)).toBe(sample.html)
      expect(await page.evaluate(() => window.getSelection().toString())).toBe(selected)
      await page.keyboard.press(`${historyModifier}+Shift+z`)
      await expect
        .poll(() => page.evaluate(() => globalThis.__orcaEditor.changes.at(-1)))
        .toBe(saved)
      await page.evaluate(
        (content) => globalThis.__orcaEditor.set({ content, generation: 1 }),
        saved
      )
      await expect
        .poll(() => page.locator('#first-surface #editor pre code').textContent())
        .toBe(sample.literal)
      expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
      expect(consoleErrors).toEqual([])
    } finally {
      await page.close()
    }
  }
}

async function verifyStructuredSelections({
  browser,
  openPage,
  setContent,
  select,
  press,
  readSurface
}) {
  const samples = [
    { markdown: '> Before after', selector: 'blockquote', caret: '> code\n> Before after' },
    { markdown: '- Before after', selector: 'ul', caret: '- code\nBefore after' },
    {
      markdown: '- [ ] Before after',
      selector: 'input[type="checkbox"]',
      caret: '- [ ] code\nBefore after'
    },
    {
      markdown: 'Before ![pixel](/inserted.png) after',
      selector: 'img',
      caret: '```\ncode\n```\n\nBefore ![pixel](/inserted.png) after'
    },
    {
      markdown: 'left ![pixel](/inserted.png) right',
      html: '<p>left <img src="/inserted.png" alt="pixel"> right</p>'
    },
    {
      markdown: '**left ![pixel](/inserted.png) right**',
      html: '<p><strong>left <img src="/inserted.png" alt="pixel"> right</strong></p>'
    },
    {
      markdown: 'left ![pixel](/inserted.png) right',
      html: '<p>left <img src="/inserted.png" alt="pixel"> right</p>',
      select: 'word'
    },
    { markdown: '- first\n- second', selector: 'ul' },
    { markdown: 'Before\n\n- first\n- second\n  - nested\n\nAfter', selector: 'ul' },
    { markdown: '- [ ] first\n  - [x] nested\n- [ ] last', selector: 'input[type="checkbox"]' },
    { markdown: 'Before\n\n---\n\nAfter', selector: 'hr' },
    { markdown: '- [ ] first\n- [x] second', selector: 'input[type="checkbox"]' },
    { markdown: '> Quoted', html: '<blockquote><p>Quoted</p></blockquote>' },
    { markdown: '| one | two |\n| --- | --- |\n| a | b |', selector: 'table' }
  ]
  for (const sample of samples) {
    const { page, consoleErrors } = await openPage(browser)
    try {
      if (sample.html) {
        await setContent(page, sample.markdown, sample.html)
      } else {
        await page.evaluate((content) => globalThis.__orcaEditor.set({ content }), sample.markdown)
        await page.waitForSelector(`#first-surface #editor ${sample.selector}`)
      }
      await (sample.caret
        ? page.evaluate(() => {
            const editor = document.querySelector('#first-surface #editor')
            editor.focus()
            const range = document.createRange()
            range.setStart(editor.querySelector('p').firstChild, 0)
            range.collapse(true)
            window.getSelection().removeAllRanges()
            window.getSelection().addRange(range)
          })
        : select(page, sample.select ?? 'all'))
      const before = await readSurface(page)
      const selected = await page.evaluate(() => window.getSelection().toString())
      await page.evaluate(() => {
        globalThis.__orcaEditor.changes.length = 0
      })
      await press(page, 'Code block')
      if (sample.caret) {
        expect(await page.locator('#first-surface #editor pre code').textContent()).toBe('code')
        expect(await page.locator(`#first-surface #editor ${sample.selector}`).count()).toBe(1)
        expect(await page.evaluate(() => globalThis.__orcaEditor.changes.at(-1))).toBe(sample.caret)
        await page.keyboard.press(`${historyModifier}+z`)
        await expect.poll(() => readSurface(page)).toBe(before)
        expect(await page.evaluate(() => window.getSelection().toString())).toBe(selected)
        await page.keyboard.press(`${historyModifier}+Shift+z`)
        await expect
          .poll(() => page.evaluate(() => globalThis.__orcaEditor.changes.at(-1)))
          .toBe(sample.caret)
      } else {
        expect(await readSurface(page)).toBe(before)
        expect(await page.evaluate(() => window.getSelection().toString())).toBe(selected)
        expect(await page.evaluate(() => globalThis.__orcaEditor.changes)).toEqual([])
      }
      expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
      expect(consoleErrors).toEqual([])
    } finally {
      await page.close()
    }
  }
}

export function codeBlockSelectionTest(
  getBrowser,
  openPage,
  setContent,
  select,
  press,
  readSurface
) {
  it(
    'preserves selected text through code-block formatting, undo and reload',
    () =>
      verifyCodeBlockSelections({
        browser: getBrowser(),
        openPage,
        setContent,
        select,
        press,
        readSurface
      }),
    600_000
  )
  structuredCodeBlockSelectionTest(getBrowser, openPage, setContent, select, press, readSurface)
}

function structuredCodeBlockSelectionTest(
  getBrowser,
  openPage,
  setContent,
  select,
  press,
  readSurface
) {
  it(
    'protects structured selections and retains existing caret code-block insertion',
    () =>
      verifyStructuredSelections({
        browser: getBrowser(),
        openPage,
        setContent,
        select,
        press,
        readSurface
      }),
    600_000
  )
}
