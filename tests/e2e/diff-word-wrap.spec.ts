import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'
import { setDiffWindowSize } from './diff-window-size'

type DiffSurface = 'file' | 'combined'

async function toggleWordWrap(page: Page, surface: DiffSurface): Promise<void> {
  if (surface === 'combined') {
    await page.getByRole('button', { name: /^Wrap (On|Off)$/ }).click()
    return
  }
  await page.getByRole('button', { name: 'File actions', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Word Wrap', exact: true }).click()
  await expect(page.getByRole('menu')).toBeHidden()
}

async function expectWrappedParagraphs(page: Page): Promise<void> {
  for (const side of ['deletions', 'additions']) {
    const pane = page.locator(`diffs-container [data-code][data-${side}]`)
    const paragraph = pane
      .locator('[data-content] [data-line]')
      .filter({ hasText: 'This long Markdown paragraph' })
      .first()
    await expect
      .poll(() => paragraph.evaluate((line) => line.getBoundingClientRect().height))
      .toBeGreaterThan(100)
    await expect
      .poll(() => pane.evaluate((code) => code.scrollWidth - code.clientWidth))
      .toBeLessThanOrEqual(1)
  }
}

for (const surface of ['file', 'combined'] as const) {
  test(`${surface} diff word wrap applies to both panes after toggles and narrow inline layout`, async ({
    orcaPage,
    electronApp,
    testRepoPath,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const fixture = createGoldenWorktree(testRepoPath, `diff-word-wrap-${surface}`)
    registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
    const paragraph =
      'This long Markdown paragraph compares the original and modified panes at their own widths. '.repeat(
        9
      )
    const readmePath = path.join(fixture.worktreePath, 'README.md')
    const content = `# Diff word wrap\n\n${paragraph}Original paragraph end.\n\n${paragraph}Second original paragraph end.\n`
    writeFileSync(readmePath, content)
    execFileSync('git', ['add', 'README.md'], { cwd: fixture.worktreePath, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'Seed long Markdown paragraphs'], {
      cwd: fixture.worktreePath,
      stdio: 'pipe'
    })
    writeFileSync(
      readmePath,
      content.replaceAll('original', 'modified').replaceAll('Original', 'Modified')
    )

    await setDiffWindowSize(electronApp, 1600, 850)
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({
        diffDefaultView: 'side-by-side',
        diffWordWrap: false
      })
    })
    await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
    const changes = orcaPage.getByRole('button', { name: /^Changes \d+$/ }).locator('..')
    await (
      surface === 'combined'
        ? changes.getByRole('button', { name: 'View all', exact: true })
        : changes
            .locator('../..')
            .locator('[data-testid="source-control-entry"]')
            .filter({ hasText: 'README.md' })
    ).click()
    await orcaPage.evaluate(() => window.__store?.getState().setRightSidebarOpen(false))
    const diff = orcaPage.locator('diffs-container pre')
    await expect(diff).toHaveAttribute('data-diff-type', 'split')
    await toggleWordWrap(orcaPage, surface)
    await orcaPage.screenshot({ path: testInfo.outputPath('wrap-on.png') })
    await expectWrappedParagraphs(orcaPage)

    await setDiffWindowSize(electronApp, 1000, 850)
    await expect(diff).toHaveAttribute('data-diff-type', 'single')
    await setDiffWindowSize(electronApp, 1600, 850)
    await expect(diff).toHaveAttribute('data-diff-type', 'split')
    await expectWrappedParagraphs(orcaPage)

    await toggleWordWrap(orcaPage, surface)
    for (const side of ['deletions', 'additions']) {
      const pane = orcaPage.locator(`diffs-container [data-code][data-${side}]`)
      await expect
        .poll(() => pane.evaluate((code) => code.scrollWidth - code.clientWidth))
        .toBeGreaterThan(500)
    }
    await toggleWordWrap(orcaPage, surface)
    await expectWrappedParagraphs(orcaPage)
  })
}
