/**
 * Invariant: Settings > Plugins shows the Alpha notice until the user dismisses it, and the
 * dismissal survives a renderer reload.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

async function openPlugins(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.openSettingsTarget({ pane: 'plugins', repoId: null })
    state?.openSettingsPage()
  })
  await expect(page.locator('[data-settings-section="plugins"]')).toBeVisible()
}

async function proofScreenshot(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const directory = process.env.ORCA_PLUGIN_ALPHA_NOTICE_PROOF_DIR
  if (!directory) {
    return
  }
  await page.evaluate(async (next) => {
    const settings = await window.api.settings.set({ theme: next })
    window.__store?.setState({ settings })
  }, theme)
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/)
  await mkdir(directory, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(directory, `alpha-banner-${theme}.png`), Buffer.from(data, 'base64'))
  } finally {
    await cdp.detach()
  }
}

test('plugins Alpha notice shows by default and stays dismissed after reload', async ({
  orcaPage
}) => {
  await openPlugins(orcaPage)
  const notice = orcaPage.getByRole('note').filter({ hasText: 'Alpha:' })
  await expect(notice).toContainText('The plugin interface may change. Expect nuances.')
  // The section's own Alpha badge stays alongside the notice.
  await expect(
    orcaPage.locator('[data-settings-section="plugins"]').getByText('Alpha', { exact: true })
  ).toBeVisible()
  await proofScreenshot(orcaPage, 'light')
  await proofScreenshot(orcaPage, 'dark')

  await notice.getByRole('button', { name: 'Dismiss Alpha notice' }).click()
  await expect(notice).toHaveCount(0)
  await expect
    .poll(() =>
      orcaPage.evaluate(async () => (await window.api.ui.get()).pluginsAlphaNoticeDismissed)
    )
    .toBe(true)

  await orcaPage.reload()
  await orcaPage.waitForFunction(() => Boolean(window.__store))
  await waitForSessionReady(orcaPage)
  await openPlugins(orcaPage)
  await expect(orcaPage.locator('[data-settings-section="plugins"]')).toContainText('Plugins')
  await expect(orcaPage.getByRole('note').filter({ hasText: 'Alpha:' })).toHaveCount(0)
})
