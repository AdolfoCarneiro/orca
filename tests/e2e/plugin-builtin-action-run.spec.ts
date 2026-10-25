/**
 * Invariant: Run on a plugin page works for built-in actions, which Settings disables, by
 * returning to the app before running them.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './helpers/orca-app'

test('runs a built-in action from its plugin page by leaving Settings first', async ({
  orcaPage
}) => {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-builtin-action-e2e-'))
  await writeFile(
    join(pluginRoot, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'builtin-run',
      publisher: 'e2e',
      name: 'Builtin Run',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {
        commands: [{ id: 'tasks', title: 'Open Tasks Now', action: 'view.tasks' }]
      }
    })
  )

  try {
    const pluginKey = await orcaPage.evaluate(async (sourcePath) => {
      const settings = await window.api.settings.set({ pluginSystemEnabled: true })
      window.__store?.setState({ settings })
      const result = await window.api.plugins.install({ kind: 'local-path', path: sourcePath })
      if (!result.ok) {
        throw new Error(result.error)
      }
      const plugin = (await window.api.plugins.refresh()).find(
        (entry) => entry.pluginKey === result.pluginKey
      )
      if (!plugin?.consentFingerprint) {
        throw new Error('installed plugin was not listed for review')
      }
      await window.api.plugins.consent({
        pluginKey: result.pluginKey,
        reviewedFingerprint: plugin.consentFingerprint,
        decision: 'approve'
      })
      const state = window.__store?.getState()
      state?.openSettingsTarget({ pane: 'plugins', repoId: null })
      state?.openSettingsPage()
      return result.pluginKey
    }, pluginRoot)

    await orcaPage.getByRole('tab', { name: /^Installed/ }).click()
    await orcaPage
      .locator(`[data-plugin-key="${pluginKey}"]`)
      .getByText('Builtin Run', { exact: true })
      .click()
    const run = orcaPage.getByRole('button', { name: 'Run Open Tasks Now', exact: true })
    await expect(run).toBeEnabled({ timeout: 15_000 })
    await run.click()

    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeView))
      .toBe('tasks')
    await expect(orcaPage.getByText('Ran Open Tasks Now')).toBeVisible()
  } finally {
    await rm(pluginRoot, { recursive: true, force: true })
  }
})
