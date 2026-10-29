import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

test('tall combined diffs keep rendered lines bounded while scrolling and editing', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'diff-viewport')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    writeFileSync(
      path.join(fixture.worktreePath, name),
      `${Array.from({ length: 800 }, (_, i) => `original ${name} line ${i + 1}`).join('\n')}\n`
    )
  }
  execFileSync('git', ['add', '.'], { cwd: fixture.worktreePath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Seed tall diffs'], {
    cwd: fixture.worktreePath,
    stdio: 'pipe'
  })
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    writeFileSync(
      path.join(fixture.worktreePath, name),
      `${Array.from({ length: 800 }, (_, i) => `modified ${name} line ${i + 1}`).join('\n')}\n`
    )
  }
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store
      ?.getState()
      .updateSettings({ diffDefaultView: 'side-by-side', diffWordWrap: false })
  })
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
  await orcaPage
    .getByRole('button', { name: /^Changes \d+$/ })
    .locator('..')
    .getByRole('button', { name: 'View all', exact: true })
    .click()
  const scroller = orcaPage.locator('.combined-diff-scroll-container')
  const first = scroller.locator('[data-combined-diff-section-row]').filter({ hasText: 'a.txt' })
  const second = scroller.locator('[data-combined-diff-section-row]').filter({ hasText: 'b.txt' })
  await expect(first.locator('.view-line').first()).toBeVisible()
  await expect(second.locator('.view-line').first()).toBeAttached()
  await expect
    .poll(() => first.evaluate((row) => row.getBoundingClientRect().height))
    .toBeGreaterThan(10_000)
  const expectBounded = async (): Promise<void> => {
    const sizes = await scroller.evaluate((element) => ({
      viewport: element.clientHeight,
      editors: Array.from(
        element.querySelectorAll('.monaco-diff-editor'),
        (editor) => editor.getBoundingClientRect().height
      ),
      lines: element.querySelectorAll('.view-line').length
    }))
    expect(sizes.editors.length).toBeGreaterThan(0)
    expect(Math.max(...sizes.editors)).toBeLessThanOrEqual(sizes.viewport)
    expect(sizes.lines).toBeLessThan(sizes.editors.length * (sizes.viewport / 8 + 20))
  }
  const settle = (): Promise<void> =>
    orcaPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
  const clickModifiedLine = async (pick: 'top' | 'bottom'): Promise<void> => {
    const text = await first.locator('.modified-in-monaco-diff-editor').evaluate((pane, edge) => {
      const bounds = pane.closest('.combined-diff-scroll-container')!.getBoundingClientRect()
      const visible = Array.from(pane.querySelectorAll('.view-line'))
        .map((line) => ({ line, top: line.getBoundingClientRect().top }))
        .filter(
          ({ line, top }) =>
            top > bounds.top + 60 && line.getBoundingClientRect().bottom < bounds.bottom - 40
        )
        .sort((a, b) => a.top - b.top)
      return visible[edge === 'top' ? 0 : visible.length - 1]?.line.textContent ?? ''
    }, pick)
    expect(text).not.toBe('')
    await first
      .locator('.modified-in-monaco-diff-editor .view-line')
      .filter({ hasText: text })
      .click()
  }
  await expectBounded()
  for (const offset of [5000, 10_000, 16_000, 24_000, 1000]) {
    await scroller.evaluate((element, top) => {
      element.scrollTop = top
    }, offset)
    await expect
      .poll(() =>
        scroller.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          return Array.from(element.querySelectorAll('.view-line')).filter((line) => {
            const rect = line.getBoundingClientRect()
            return rect.bottom > bounds.top && rect.top < bounds.bottom
          }).length
        })
      )
      .toBeGreaterThan(5)
    await expectBounded()
  }

  // Lines must keep their place in the row while the window clamps at the end of the file.
  const lineDrift = await first.evaluate(async (row) => {
    const scrollContainer = row.closest<HTMLElement>('.combined-diff-scroll-container')!
    const rowElement = row as HTMLElement
    const end = rowElement.offsetTop + rowElement.offsetHeight
    const offsets = new Set<number>()
    for (let top = end - 3 * scrollContainer.clientHeight; top <= end; top += 7) {
      scrollContainer.scrollTop = top
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const bounds = scrollContainer.getBoundingClientRect()
      const rowTop = row.getBoundingClientRect().top
      const lines = Array.from(row.querySelectorAll('.modified-in-monaco-diff-editor .view-line'))
        .map((line) => ({
          rect: line.getBoundingClientRect(),
          number: Number(/line (\d+)/.exec((line.textContent ?? '').replace(/ /g, ' '))?.[1])
        }))
        .filter(
          ({ rect, number }) => number && rect.top > bounds.top + 40 && rect.bottom < bounds.bottom
        )
        .sort((a, b) => a.number - b.number)
      if (lines.length < 2) {
        continue
      }
      const lineHeight = lines[1]!.rect.top - lines[0]!.rect.top
      offsets.add(Math.round(lines[0]!.rect.top - rowTop - (lines[0]!.number - 1) * lineHeight))
    }
    return [...offsets]
  })
  expect(lineDrift.length).toBeGreaterThan(0)
  expect(Math.max(...lineDrift) - Math.min(...lineDrift)).toBeLessThanOrEqual(1)

  // Find opens inside the visible slice, not above it.
  await scroller.evaluate((element) => {
    element.scrollTop = 5000
  })
  await settle()
  await clickModifiedLine('top')
  await orcaPage.keyboard.press('ControlOrMeta+f')
  const findWidget = first.locator('.modified-in-monaco-diff-editor .find-widget.visible')
  await expect(findWidget).toBeVisible()
  await expect
    .poll(async () => {
      const [findBox, scrollBox] = await Promise.all([
        findWidget.boundingBox(),
        scroller.boundingBox()
      ])
      return Boolean(
        findBox &&
        scrollBox &&
        findBox.y >= scrollBox.y &&
        findBox.y + findBox.height <= scrollBox.y + scrollBox.height
      )
    })
    .toBe(true)
  await orcaPage.keyboard.press('Escape')

  // Arrowing past the bottom edge scrolls the list instead of hiding the cursor.
  await clickModifiedLine('bottom')
  const scrollTopBeforeArrows = await scroller.evaluate((element) => element.scrollTop)
  for (let press = 0; press < 30; press += 1) {
    await orcaPage.keyboard.press('ArrowDown')
  }
  await settle()
  const cursorBox = await first
    .locator('.modified-in-monaco-diff-editor .cursors-layer .cursor')
    .boundingBox()
  const scrollBox = await scroller.boundingBox()
  expect(cursorBox && scrollBox).toBeTruthy()
  expect(cursorBox!.y + cursorBox!.height).toBeLessThanOrEqual(scrollBox!.y + scrollBox!.height)
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    scrollTopBeforeArrows
  )

  await scroller.evaluate((element) => {
    element.scrollTop = 5000
  })
  await expect(
    first
      .locator('.modified-in-monaco-diff-editor .view-line')
      .filter({ hasText: 'modified a.txt line 300' })
  ).toBeAttached()
  const visibleText = await first.locator('.modified-in-monaco-diff-editor').evaluate((pane) => {
    const scroller = pane.closest('.combined-diff-scroll-container')
    if (!scroller) {
      throw new Error('Missing diff scroll container')
    }
    const bounds = scroller.getBoundingClientRect()
    const line = Array.from(pane.querySelectorAll('.view-line')).find((line) => {
      const rect = line.getBoundingClientRect()
      return rect.top > bounds.top + 60 && rect.bottom < bounds.bottom - 30
    })
    if (!line?.textContent) {
      throw new Error('No visible modified line')
    }
    return line.textContent
  })
  await first
    .locator('.modified-in-monaco-diff-editor .view-line')
    .filter({ hasText: visibleText })
    .click()
  await orcaPage.keyboard.press('End')
  await orcaPage.keyboard.insertText(' edited')
  await orcaPage.keyboard.press('ControlOrMeta+s')
  await expect
    .poll(() => readFileSync(path.join(fixture.worktreePath, 'a.txt'), 'utf8'))
    .toContain(' edited')
  await orcaPage.evaluate(async () => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Missing active workspace')
    }
    const comment = await state.addDiffComment({
      worktreeId: state.activeWorktreeId,
      filePath: 'a.txt',
      lineNumber: 600,
      body: 'Note beyond the rendered viewport',
      side: 'modified'
    })
    if (!comment) {
      throw new Error('Failed to add diff note')
    }
    state.setScrollToDiffCommentId(comment.id)
  })
  const note = first
    .locator('.orca-diff-comment-card')
    .filter({ hasText: 'Note beyond the rendered viewport' })
  await expect(note).toBeVisible()
  await expect
    .poll(async () => {
      const [noteBox, scrollBox] = await Promise.all([note.boundingBox(), scroller.boundingBox()])
      return (
        noteBox &&
        scrollBox &&
        noteBox.y >= scrollBox.y &&
        noteBox.y + noteBox.height <= scrollBox.y + scrollBox.height
      )
    })
    .toBe(true)
  await expectBounded()
  await orcaPage.screenshot({ path: testInfo.outputPath('bounded-diff.png') })
})
