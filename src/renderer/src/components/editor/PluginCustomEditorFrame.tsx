import React, { useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { ActivePluginCustomEditor } from '@/store/plugin-custom-editors'
import {
  PANEL_PING_TYPE,
  PLUGIN_PANEL_FRAME_NAME_PREFIX
} from '../../../../shared/plugins/plugin-panel-bridge'
import {
  fillPluginPanelShell,
  postPluginFrameTheme
} from '../right-sidebar/plugin-panel-design-token-css'
import { createPanelWatchdog } from '../right-sidebar/plugin-panel-watchdog'
import { usePluginFrameThemeSync } from '../right-sidebar/use-plugin-panel-theme-revision'
import { editorShortcutMatches } from './editor-shortcuts'
import { registerEditorFrameFlush } from './editor-pending-flush'
import {
  createCustomEditorHost,
  type CustomEditorBinaryDocument,
  type CustomEditorEditRefusal
} from './plugin-custom-editor-host'

type PluginCustomEditorFrameProps = {
  editor: ActivePluginCustomEditor
  /** The tab's file id; every save of it first flushes this frame. */
  fileId?: string
  content: string
  readOnly: boolean
  onContentChange: (content: string) => void
  onSave: (content: string) => Promise<boolean>
  /** Marks the tab dirty while the frame holds edits the buffer lacks. */
  onDirtyHint?: (dirty: boolean) => void
  /** Set for a binary editor: its bytes once loaded (null before). Text props are then unused. */
  binaryDocument?: CustomEditorBinaryDocument | null
  onBytesChange?: (document: CustomEditorBinaryDocument) => void
}

type EntryState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'unresponsive' }
  | { status: 'ready'; html: string; revision: number }

function FrameMessage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/** A plugin's sandboxed editor for the open file. It only exchanges the document with this tab. */
export default function PluginCustomEditorFrame({
  editor,
  fileId,
  content,
  readOnly,
  onContentChange,
  onSave,
  onDirtyHint,
  binaryDocument,
  onBytesChange
}: PluginCustomEditorFrameProps): React.JSX.Element {
  const [entry, setEntry] = useState<EntryState>({ status: 'loading' })
  const [refusal, setRefusal] = useState<CustomEditorEditRefusal | null>(null)
  const [saveBlocked, setSaveBlocked] = useState(false)
  const [loadedFrameKey, setLoadedFrameKey] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  usePluginFrameThemeSync(iframeRef)
  // Why random: window.name is readable inside the frame, so it must not carry the file's path.
  const [frameName] = useState(
    () => `${PLUGIN_PANEL_FRAME_NAME_PREFIX}editor:${createBrowserUuid()}`
  )
  // Why refs: the host is built once per frame; props change on every keystroke.
  const latestRef = useRef({
    content,
    readOnly,
    onContentChange,
    onSave,
    onDirtyHint,
    binaryDocument,
    onBytesChange
  })
  latestRef.current = {
    content,
    readOnly,
    onContentChange,
    onSave,
    onDirtyHint,
    binaryDocument,
    onBytesChange
  }
  const isBinary = binaryDocument !== undefined

  const { pluginKey, id: editorId } = editor
  useEffect(() => {
    let cancelled = false
    let currentHtml: string | null = null
    let revision = 0
    const pluginsApi = window.api?.plugins
    const readEntry = pluginsApi?.readCustomEditorEntry
    if (!pluginsApi || !readEntry) {
      setEntry({ status: 'error' })
      return
    }
    setEntry({ status: 'loading' })
    const load = (): void => {
      readEntry({ pluginKey, editorId })
        .then((result) => {
          if (cancelled) {
            return
          }
          if (!result) {
            currentHtml = null
            setEntry({ status: 'error' })
            return
          }
          // Plugin list changes fire often; only new bytes remount the frame.
          if (result.html !== currentHtml) {
            currentHtml = result.html
            revision += 1
            setEntry({ status: 'ready', html: result.html, revision })
          }
        })
        .catch(() => {
          if (!cancelled) {
            currentHtml = null
            setEntry({ status: 'error' })
          }
        })
    }
    load()
    const unsubscribe = pluginsApi.onChanged ? pluginsApi.onChanged(load) : null
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [pluginKey, editorId])

  const frameKey = entry.status === 'ready' ? `${editor.key}:${entry.revision}` : null
  const entryHtml = entry.status === 'ready' ? entry.html : null
  // Why memoized: a new srcdoc reloads the frame; theme changes arrive as messages instead.
  const frameDocument = useMemo(
    () => (entryHtml === null ? null : fillPluginPanelShell(entryHtml)),
    [entryHtml]
  )

  const watchdog = useMemo(
    () =>
      createPanelWatchdog({
        sendPing: (pingId) =>
          iframeRef.current?.contentWindow?.postMessage({ type: PANEL_PING_TYPE, pingId }, '*'),
        onUnresponsive: () => setEntry({ status: 'unresponsive' })
      }),
    []
  )

  const host = useMemo(() => {
    const created = createCustomEditorHost({
      getFrameWindow: () => iframeRef.current?.contentWindow ?? null,
      getDocument: () => ({
        text: latestRef.current.content,
        readOnly: latestRef.current.readOnly
      }),
      ...(isBinary ? { getBinaryDocument: () => latestRef.current.binaryDocument ?? null } : {}),
      onEdit: (text) => {
        setRefusal(null)
        setSaveBlocked(false)
        latestRef.current.onContentChange(text)
      },
      onBytesEdit: (document) => {
        setRefusal(null)
        setSaveBlocked(false)
        latestRef.current.onBytesChange?.(document)
      },
      onEditRefused: setRefusal,
      onUnappliedEdit: (state) => {
        if (state !== null) {
          latestRef.current.onDirtyHint?.(true)
        }
      },
      onPong: (pingId) => watchdog.handlePong(pingId),
      onKeyChord: (chord) => {
        const event = new KeyboardEvent('keydown', chord)
        // Why: chords are posted by frame code, so only one riding real user input may save.
        if (
          latestRef.current.readOnly ||
          navigator.userActivation?.isActive !== true ||
          !editorShortcutMatches('editor.save', event)
        ) {
          return
        }
        // The save pipeline flushes this frame first; see registerEditorFrameFlush below.
        void latestRef.current.onSave(created.currentText())
      }
    })
    return created
  }, [watchdog, isBinary])

  useEffect(() => {
    if (!frameKey) {
      return
    }
    window.addEventListener('message', host.handleMessage)
    return () => {
      window.removeEventListener('message', host.handleMessage)
      host.reset()
    }
  }, [frameKey, host])

  useEffect(() => {
    if (!frameKey || loadedFrameKey !== frameKey) {
      return
    }
    // Ping only once srcdoc (and its pong responder) has loaded.
    watchdog.start()
    return () => watchdog.stop()
  }, [frameKey, loadedFrameKey, watchdog])

  useEffect(() => {
    host.syncDocument()
  }, [content, readOnly, binaryDocument, host])

  useEffect(() => {
    if (fileId === undefined) {
      return
    }
    return registerEditorFrameFlush(fileId, async () => {
      const flushed = await host.flush()
      setSaveBlocked(!flushed)
      return flushed
    })
  }, [fileId, host])

  if (entry.status === 'loading') {
    return (
      <FrameMessage>
        {translate('auto.components.editor.PluginCustomEditorFrame.loading', 'Loading editor…')}
      </FrameMessage>
    )
  }
  if (entry.status === 'unresponsive') {
    return (
      <FrameMessage>
        {translate(
          'auto.components.editor.PluginCustomEditorFrame.unresponsive',
          '{{value0}} stopped responding. Switch to Source to keep editing.',
          { value0: editor.title }
        )}
      </FrameMessage>
    )
  }
  if (entry.status === 'error') {
    return (
      <FrameMessage>
        {translate(
          'auto.components.editor.PluginCustomEditorFrame.loadFailed',
          '{{value0}} could not be loaded. Switch to Source to edit this file.',
          { value0: editor.title }
        )}
      </FrameMessage>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {saveBlocked ? (
        <div className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          {translate(
            'auto.components.editor.PluginCustomEditorFrame.saveBlocked',
            "Couldn't save the latest changes from {{value0}}.",
            { value0: editor.title }
          )}
        </div>
      ) : refusal ? (
        <div className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          {refusal === 'oversized'
            ? translate(
                'auto.components.editor.PluginCustomEditorFrame.editTooLarge',
                'This file is too large for {{value0}} to save changes. Use Source instead.',
                { value0: editor.title }
              )
            : translate(
                'auto.components.editor.PluginCustomEditorFrame.editsHeld',
                '{{value0}} is sending changes too quickly; Orca applies the latest one shortly.',
                { value0: editor.title }
              )}
        </div>
      ) : null}
      <iframe
        key={frameKey}
        ref={iframeRef}
        // SECURITY: never add allow-same-origin — the srcdoc frame must stay an opaque origin so
        // plugin UI cannot reach the app DOM, storage, IPC or the file it edits.
        sandbox="allow-scripts"
        name={frameName}
        srcDoc={frameDocument ?? ''}
        onLoad={() => {
          setLoadedFrameKey(frameKey)
          // The theme may have changed between building srcdoc and the frame loading it.
          postPluginFrameTheme(iframeRef.current?.contentWindow)
        }}
        title={editor.title}
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
    </div>
  )
}
