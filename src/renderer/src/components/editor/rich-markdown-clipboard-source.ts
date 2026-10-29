import type { Editor } from '@tiptap/core'
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { useAppStore } from '@/store'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { createRuntimeImportSessionGuard } from '@/runtime/runtime-file-mutation-rpc'
import { documentResourceAccess } from '@/lib/local-file-access'
import { readRichMarkdownImageRuntimeContext } from './rich-markdown-image-context'
import type { RichMarkdownImageRuntimeContext } from './rich-markdown-image-context'

export type RichMarkdownClipboardSource = {
  filePath: string
  runtimeContext?: RichMarkdownImageRuntimeContext
  access: ReturnType<typeof documentResourceAccess>
  assertCurrent?: () => void
}

export function sameRichMarkdownClipboardFileOwner(
  source: RichMarkdownImageRuntimeContext | undefined,
  destination: Pick<
    RichMarkdownImageRuntimeContext,
    'target' | 'connectionId' | 'expectedExternalSshTargetId'
  >
): boolean {
  return (
    (source?.target.kind ?? 'local') === destination.target.kind &&
    (source?.target.kind !== 'environment' ||
      (destination.target.kind === 'environment' &&
        source.target.environmentId === destination.target.environmentId)) &&
    (source?.connectionId ?? null) === (destination.connectionId ?? null) &&
    source?.expectedExternalSshTargetId === destination.expectedExternalSshTargetId
  )
}

function captureSourceGuard(
  context: RichMarkdownImageRuntimeContext | undefined
): (() => void) | undefined {
  if (context?.target.kind === 'environment') {
    return createRuntimeImportSessionGuard(
      context.target.environmentId,
      captureRuntimeEnvironmentRequestRevision(context.target.environmentId),
      getRuntimeEnvironmentConnectionGeneration(context.target.environmentId)
    )
  }
  const connectionId = context?.connectionId
  if (!connectionId) {
    return undefined
  }
  const expected = captureDirectSshMutationExpectation(useAppStore.getState(), connectionId)
  return () => {
    const current = captureDirectSshMutationExpectation(useAppStore.getState(), connectionId)
    if (current.expectedSshConnectionGeneration !== expected.expectedSshConnectionGeneration) {
      throw new Error('Source image connection changed; copy the selection again.')
    }
  }
}

export function captureRichMarkdownClipboardSource(
  editor: Editor
): RichMarkdownClipboardSource | null {
  const storage: unknown = 'image' in editor.storage ? editor.storage.image : undefined
  if (
    !storage ||
    typeof storage !== 'object' ||
    !('filePath' in storage) ||
    typeof storage.filePath !== 'string' ||
    !storage.filePath
  ) {
    return null
  }
  const context = readRichMarkdownImageRuntimeContext({
    runtimeContext: 'runtimeContext' in storage ? storage.runtimeContext : undefined
  })
  if (context === null) {
    return null
  }
  const runtimeContext = context ? { ...context, target: { ...context.target } } : undefined
  const filePath = storage.filePath
  let assertCurrent: (() => void) | undefined
  try {
    assertCurrent = captureSourceGuard(runtimeContext)
  } catch {
    return null
  }
  return { filePath, runtimeContext, access: documentResourceAccess(filePath), assertCurrent }
}
