import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('gutter remote URL uses the mounted editor file instead of a same-path sibling', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'gutter-url-owner.ts'
  const filePath = path.join(context.rootPath, relativePath)
  await writeFile(filePath, '// The copied URL should belong to this editor.\n')
  registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))
  const fileId = await orcaPage.evaluate(
    ({ context, relativePath, filePath }) =>
      window.__store?.getState().openFile(
        {
          worktreeId: context.worktreeId,
          filePath,
          relativePath,
          language: 'typescript',
          mode: 'edit',
          runtimeEnvironmentId: null
        },
        { preview: false }
      ),
    { context, relativePath, filePath }
  )
  if (!fileId) {
    throw new Error('Expected a source file tab')
  }
  await expect(orcaPage.locator('.monaco-editor')).toBeVisible()
  await expect(orcaPage.locator('.view-line').filter({ hasText: 'The copied URL' })).toBeVisible()

  // Duplicate host rows are seeded; the menu and clipboard use their real renderer/IPC paths.
  await orcaPage.evaluate(
    ({ fileId }) => {
      const store = window.__store
      const state = store?.getState()
      const file = state?.openFiles.find((candidate) => candidate.id === fileId)
      const worktree = Object.values(state?.worktreesByRepo ?? {})
        .flat()
        .find((candidate) => candidate.id === file?.worktreeId)
      if (!store || !state || !file || !worktree) {
        throw new Error('Expected the owning file and workspace')
      }
      const siblingWorktree = {
        ...worktree,
        id: 'gutter-sibling-workspace',
        path: '/same-path-sibling-host/repo'
      }
      store.setState({
        openFiles: [
          { ...file, id: 'gutter-sibling-file', worktreeId: siblingWorktree.id },
          ...state.openFiles
        ],
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [worktree.repoId]: [siblingWorktree, ...state.worktreesByRepo[worktree.repoId]]
        }
      })
    },
    { fileId }
  )
  const targetUrl = `https://example.invalid/host-b/blob/main/${relativePath}#L1`
  const siblingUrl = `https://example.invalid/host-a/blob/main/${relativePath}#L1`
  await electronApp.evaluate(
    ({ ipcMain, clipboard }, { rootPath, targetUrl, siblingUrl }) => {
      clipboard.writeText('')
      ipcMain.removeHandler('git:remoteFileUrl')
      ipcMain.handle('git:remoteFileUrl', (_event, args: { worktreePath: string }) =>
        args.worktreePath === rootPath ? targetUrl : siblingUrl
      )
    },
    { rootPath: context.rootPath, targetUrl, siblingUrl }
  )
  await orcaPage.locator('.margin-view-overlays .line-numbers').first().click({ button: 'right' })
  await expect(
    orcaPage.getByRole('menuitem', { name: 'Copy Remote URL', exact: true })
  ).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('gutter-menu-open.png') })
  await orcaPage.getByRole('menuitem', { name: 'Copy Remote URL', exact: true }).click()
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
    .not.toBe('')
  const copiedUrl = await electronApp.evaluate(({ clipboard }) => clipboard.readText())
  const sourceLine = orcaPage.locator('.view-line').filter({ hasText: 'The copied URL' })
  await sourceLine.click()
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await orcaPage.keyboard.press('Enter')
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v')
  await expect(orcaPage.locator('.view-line').filter({ hasText: copiedUrl })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('copied-owner-url.png') })
  const evidencePath = testInfo.outputPath('gutter-url-owner.json')
  await writeFile(
    evidencePath,
    JSON.stringify({ fileId, targetUrl, siblingUrl, copiedUrl }, null, 2)
  )
  await testInfo.attach('gutter-url-owner', { path: evidencePath, contentType: 'application/json' })
  expect(copiedUrl).toBe(targetUrl)
})
