import React, { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { readRuntimeFileBytes } from '@/runtime/runtime-paged-file-read'
import type { ActivePluginCustomEditor } from '@/store/plugin-custom-editors'
import { CUSTOM_EDITOR_DOCUMENT_MAX_BYTES } from '../../../../shared/plugins/plugin-custom-editor-bridge'
import { matchCustomEditorFileType } from '../../../../shared/plugins/plugin-custom-editor-contribution'
import { formatBytes } from '../status-bar/workspace-space-format'
import { Button } from '../ui/button'
import type { FileContent } from './editor-panel-content-types'
import PluginCustomEditorFrame from './PluginCustomEditorFrame'
import type { CustomEditorBinaryDocument } from './plugin-custom-editor-host'

type BytesState =
  | { status: 'loading'; document: CustomEditorBinaryDocument | null }
  | { status: 'ready'; document: CustomEditorBinaryDocument }
  | { status: 'too_large'; size: number }
  | { status: 'unsupported' }
  | { status: 'error'; message: string }

const noopContentChange = (_content: string): void => {}
const noopSave = async (_content: string): Promise<boolean> => false

function SurfaceMessage({
  children,
  onRetry
}: {
  children: React.ReactNode
  onRetry?: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <p className="max-w-md">{children}</p>
      {onRetry ? (
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          {translate('auto.components.editor.PluginBytesCustomEditorSurface.retry', 'Retry')}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * A read-only bytes editor: Orca pages the file from the host that owns it (local, SSH or a
 * paired runtime), caps its size, and hands the frame only the bytes, never a path.
 */
export default function PluginBytesCustomEditorSurface({
  editor,
  filePath,
  fileContent
}: {
  editor: ActivePluginCustomEditor
  filePath: string
  fileContent: FileContent
}): React.JSX.Element {
  const [state, setState] = useState<BytesState>({ status: 'loading', document: null })
  const [attempt, setAttempt] = useState(0)
  const fileType = matchCustomEditorFileType(filePath, editor.fileTypes) ?? ''
  const source = fileContent.byteSource
  // Why the object: every reload (an outside change included) lands as a new FileContent.
  const loadKey = fileContent.isStale ? null : fileContent

  useEffect(() => {
    if (!loadKey) {
      return
    }
    if (!source) {
      setState({ status: 'unsupported' })
      return
    }
    let cancelled = false
    // Keep the last bytes on screen while a reload runs.
    setState((previous) =>
      previous.status === 'ready' ? { status: 'loading', document: previous.document } : previous
    )
    readRuntimeFileBytes(source, CUSTOM_EDITOR_DOCUMENT_MAX_BYTES)
      .then((read) => {
        if (cancelled) {
          return
        }
        if (read.kind === 'ok') {
          setState({ status: 'ready', document: { bytes: read.bytes, fileType } })
        } else if (read.kind === 'too_large') {
          setState({ status: 'too_large', size: read.size })
        } else {
          setState({ status: 'unsupported' })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: error instanceof Error ? error.message : '' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [loadKey, source, fileType, attempt])

  const name = basename(filePath)
  if (state.status === 'too_large') {
    return (
      <SurfaceMessage>
        {translate(
          'auto.components.editor.PluginBytesCustomEditorSurface.tooLarge',
          '{{value0}} is too large to open in {{value1}} ({{value2}}; the limit is {{value3}}).',
          {
            value0: name,
            value1: editor.title,
            value2: formatBytes(state.size),
            value3: formatBytes(CUSTOM_EDITOR_DOCUMENT_MAX_BYTES)
          }
        )}
      </SurfaceMessage>
    )
  }
  if (state.status === 'unsupported') {
    return (
      <SurfaceMessage>
        {translate(
          'auto.components.editor.PluginBytesCustomEditorSurface.unsupported',
          "{{value0}} can't read this file from where it is stored. Update the Orca server that hosts it, or switch to Source.",
          { value0: editor.title }
        )}
      </SurfaceMessage>
    )
  }
  if (state.status === 'error') {
    return (
      <SurfaceMessage onRetry={() => setAttempt((current) => current + 1)}>
        {translate(
          'auto.components.editor.PluginBytesCustomEditorSurface.readFailed',
          "{{value0}} couldn't be read for {{value1}}. {{value2}}",
          { value0: name, value1: editor.title, value2: state.message }
        )}
      </SurfaceMessage>
    )
  }
  return (
    <PluginCustomEditorFrame
      editor={editor}
      content=""
      readOnly
      onContentChange={noopContentChange}
      onSave={noopSave}
      binaryDocument={state.document}
    />
  )
}
