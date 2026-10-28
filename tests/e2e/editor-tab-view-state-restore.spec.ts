import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

test('preserves folded code and horizontal scroll across editor tab switches', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'editor-view-state')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  writeFileSync(
    path.join(fixture.worktreePath, 'src', 'view-state.ts'),
    [
      'export function preservedBlock() {',
      '  const first = "Keep this block folded while reading the next declaration"',
      '  const second = "Switching tabs must preserve reading context"',
      '  return first + second',
      '}',
      '',
      `export const longLine = "${'horizontal reading context | '.repeat(80)}"`,
      ''
    ].join('\n')
  )

  await orcaPage.setViewportSize({ width: 1400, height: 850 })
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ editorWordWrap: false })
  })
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarTab('explorer')
    state?.setRightSidebarOpen(true)
  })

  const explorer = orcaPage.locator('[data-orca-explorer-shell]')
  const rowNamed = (name: string) =>
    explorer.locator('[data-file-explorer-row]').filter({
      has: orcaPage.locator('[data-file-explorer-row-name]').getByText(name, { exact: true })
    })
  await rowNamed('src').click()
  await rowNamed('view-state.ts').dblclick()
  const monaco = orcaPage.locator('.monaco-editor').first()
  await expect(monaco).toBeVisible({ timeout: 25_000 })
  await monaco.hover()
  await monaco.locator('.codicon-folding-expanded').first().click()
  await expect(monaco.locator('.codicon-folding-collapsed')).toHaveCount(1)
  await expect(monaco.locator('.view-line').filter({ hasText: 'const first' })).toHaveCount(0)

  await monaco.hover({ position: { x: 220, y: 70 } })
  for (let index = 0; index < 8; index += 1) {
    await orcaPage.mouse.wheel(600, 0)
  }
  const horizontalOffset = () =>
    monaco
      .locator('.lines-content')
      .first()
      .evaluate((element) => Number.parseFloat(element.style.left))
  await expect.poll(horizontalOffset).toBeLessThan(-100)
  let lastOffset = Number.NaN
  let stableSamples = 0
  await expect
    .poll(
      async () => {
        const offset = await horizontalOffset()
        stableSamples = offset === lastOffset ? stableSamples + 1 : 0
        lastOffset = offset
        return stableSamples
      },
      { intervals: [100] }
    )
    .toBeGreaterThanOrEqual(3)
  await orcaPage.screenshot({ path: testInfo.outputPath('before-tab-switch.png') })
  const beforeOffset = await horizontalOffset()
  await rowNamed('index.ts').dblclick()
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('index.ts')
  await orcaPage.locator('[data-tab-id]').filter({ hasText: 'view-state.ts' }).last().click()
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('view-state.ts')
  try {
    await expect(monaco.locator('.codicon-folding-collapsed')).toHaveCount(1)
    await expect(monaco.locator('.view-line').filter({ hasText: 'const first' })).toHaveCount(0)
    await expect.poll(horizontalOffset).toBe(beforeOffset)
  } finally {
    const readingContextPath = testInfo.outputPath('reading-context.json')
    writeFileSync(
      readingContextPath,
      JSON.stringify({
        before: { collapsedBlocks: 1, horizontalScroll: -beforeOffset },
        after: {
          collapsedBlocks: await monaco.locator('.codicon-folding-collapsed').count(),
          horizontalScroll: -(await horizontalOffset())
        }
      })
    )
    await testInfo.attach('reading-context', {
      path: readingContextPath,
      contentType: 'application/json'
    })
    await orcaPage.screenshot({ path: testInfo.outputPath('after-tab-switch.png') })
  }
})
