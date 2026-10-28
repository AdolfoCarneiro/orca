import { expect, it } from 'vitest'

const historyModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

export function collapsedCodeBlockTest(getBrowser, openPage, press, readSurface) {
  it('retains caret code blocks through typing, native history and repeated saves', async () => {
    const contexts = [
      { name: 'paragraph', markdown: 'First\n\nOutside', selector: 'p' },
      { name: 'bullet', markdown: '- First\n- Next\n\nOutside', selector: 'li p' },
      { name: 'task', markdown: '- [x] First\n- [ ] Next\n\nOutside', selector: 'li p' }
    ]
    for (const context of contexts) {
      for (const position of ['start', 'middle', 'end']) {
        const { page, consoleErrors } = await openPage(getBrowser())
        try {
          await page.evaluate(
            (content) => globalThis.__orcaEditor.set({ content }),
            context.markdown
          )
          await page.waitForFunction(
            (selector) =>
              document.querySelector(`#first-surface #editor ${selector}`)?.textContent === 'First',
            context.selector
          )
          await page.evaluate(
            ({ selector, position }) => {
              const editor = document.querySelector('#first-surface #editor')
              const paragraph = editor.querySelector(selector)
              editor.focus()
              const range = document.createRange()
              range.selectNodeContents(paragraph)
              range.collapse(position === 'start')
              if (position === 'middle') {
                range.setStart(paragraph.firstChild, 2)
                range.collapse(true)
              }
              window.getSelection().removeAllRanges()
              window.getSelection().addRange(range)
            },
            { selector: context.selector, position }
          )
          const before = await readSurface(page)
          await press(page, 'Code block')
          const code = page.locator('#first-surface #editor pre code')
          expect(await code.textContent()).toBe('code')
          const inserted = await readSurface(page)
          await page.keyboard.press(`${historyModifier}+z`)
          await expect.poll(() => readSurface(page)).toBe(before)
          await page.keyboard.press(`${historyModifier}+Shift+z`)
          await expect.poll(() => readSurface(page)).toBe(inserted)
          await page.evaluate(() => {
            const editor = document.querySelector('#first-surface #editor')
            const range = document.createRange()
            range.selectNodeContents(editor.querySelector('pre code'))
            range.collapse(false)
            editor.focus()
            window.getSelection().removeAllRanges()
            window.getSelection().addRange(range)
          })
          await page.keyboard.insertText(' typed')
          await expect.poll(() => code.textContent()).toBe('code typed')
          const typed = await readSurface(page)
          await page.keyboard.press(`${historyModifier}+z`)
          await expect.poll(() => readSurface(page)).toBe(inserted)
          await page.keyboard.press(`${historyModifier}+z`)
          await expect.poll(() => readSurface(page)).toBe(before)
          await page.keyboard.press(`${historyModifier}+Shift+z`)
          await expect.poll(() => readSurface(page)).toBe(inserted)
          await page.keyboard.press(`${historyModifier}+Shift+z`)
          await expect.poll(() => readSurface(page)).toBe(typed)
          const saved = await page.evaluate(() => globalThis.__orcaEditor.changes.at(-1))
          expect(saved.includes('code typed')).toBe(true)
          for (const generation of [1, 2]) {
            await page.evaluate(() => {
              globalThis.__orcaPreviousEditor = document.querySelector('#first-surface #editor')
            })
            await page.evaluate(
              ({ content, generation }) => globalThis.__orcaEditor.set({ content, generation }),
              { content: saved, generation }
            )
            await page.waitForFunction(
              () =>
                document.querySelector('#first-surface #editor') !== null &&
                document.querySelector('#first-surface #editor') !== globalThis.__orcaPreviousEditor
            )
            await expect
              .poll(() => page.locator('#first-surface #editor pre code').textContent())
              .toBe('code typed')
            await page.evaluate(() => {
              const editor = document.querySelector('#first-surface #editor')
              editor.dispatchEvent(new Event('input', { bubbles: true }))
            })
            await expect
              .poll(() => page.evaluate(() => globalThis.__orcaEditor.changes.at(-1)))
              .toBe(saved)
          }
          expect(await page.evaluate(() => globalThis.__orcaCspViolations)).toEqual([])
          expect(consoleErrors).toEqual([])
        } finally {
          await page.close()
        }
      }
    }
  }, 600_000)
}
