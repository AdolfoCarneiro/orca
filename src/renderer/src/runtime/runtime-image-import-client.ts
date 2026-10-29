import type { LocalFileAccess } from '../../../shared/local-file-access'
import { assertClipboardImageBase64LengthWithinLimit } from '../../../shared/clipboard-image'
import { deconflictCopyName } from '../../../shared/import-copy-name'
import { joinPath } from '@/lib/path'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import { importExternalPathsToRuntime } from './runtime-file-import-client'
import { createRuntimeFileImportSession } from './runtime-file-mutation-rpc'
import { runtimePathExists } from './runtime-file-metadata-client'
import { getRemoteFileArgs, joinRuntimeRelativePath } from './runtime-file-routing'
import { uploadRuntimeFileWithoutClobber } from './runtime-file-upload-client'
import { callRuntimeRpc } from './runtime-rpc-client'

export async function importRuntimeImage(
  context: RuntimeFileOperationArgs,
  contentBase64: string,
  destinationDir: string,
  options: { access?: LocalFileAccess; assertCurrent: () => void; signal: AbortSignal }
): Promise<string> {
  assertClipboardImageBase64LengthWithinLimit(contentBase64.length)
  options.assertCurrent()
  if (context.target.kind !== 'environment') {
    const sourcePath = await callRuntimeRpc<string>(
      { kind: 'local' },
      'clipboard.saveImageAsTempFile',
      { contentBase64, connectionId: context.connectionId },
      { signal: options.signal }
    )
    options.assertCurrent()
    const { results } = await importExternalPathsToRuntime(
      context,
      [sourcePath],
      destinationDir,
      options
    )
    options.assertCurrent()
    const imported = results.find((result) => result.status === 'imported')
    if (!imported) {
      throw new Error('Failed to save pasted image beside the document.')
    }
    return imported.destPath
  }

  if (!context.worktreeId || !context.worktreePath) {
    throw new Error('Worktree path not available.')
  }
  const destination = getRemoteFileArgs(context, destinationDir)
  if (!destination) {
    throw new Error('Destination is outside the active runtime worktree')
  }
  const session = await createRuntimeFileImportSession(context.target, options.assertCurrent)
  const name = await deconflictCopyName(
    `orca-paste-${createBrowserUuid()}.png`,
    async (candidate) => {
      session.assertCurrent()
      return runtimePathExists(
        context,
        joinPath(destinationDir, candidate),
        session.expectedEnvironmentPairingRevision
      )
    }
  )
  await uploadRuntimeFileWithoutClobber(
    session,
    context.worktreeId,
    joinRuntimeRelativePath(destination.relativePath, name),
    { contentBase64 },
    context.expectedSshConnectionGeneration,
    context.expectedSshTargetId,
    context.expectedExecutionHostId ??
      (context.expectedSshTargetId
        ? `ssh:${encodeURIComponent(context.expectedSshTargetId)}`
        : 'local')
  )
  options.assertCurrent()
  return joinPath(destinationDir, name)
}
