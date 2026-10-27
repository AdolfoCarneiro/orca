import React, { useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { ActivePluginCustomEditor } from '@/store/plugin-custom-editors'
import { moveFocusToRendererBeforeWebviewDetach } from '@/components/browser-pane/host-guest/webview-registry'
import { PANEL_PING_TYPE } from '../../../../shared/plugins/plugin-panel-bridge'
import {
  PLUGIN_EDITOR_GUEST_DELIVER_CHANNEL,
  PLUGIN_EDITOR_PARTITION,
  type PluginEditorGuestOpenResult
} from '../../../../shared/plugins/plugin-editor-guest'
import {
  buildPanelDesignTokenCss,
  currentPanelColorScheme,
  pluginFrameThemeMessage
} from '../right-sidebar/plugin-panel-design-token-css'
import { createPanelWatchdog } from '../right-sidebar/plugin-panel-watchdog'
import { usePluginPanelThemeRevision } from '../right-sidebar/use-plugin-panel-theme-revision'
import { editorShortcutMatches } from './editor-shortcuts'
import { registerEditorFrameFlush } from './editor-pending-flush'
import {
  createCustomEditorHost,
  type CustomEditorBinaryDocument,
  type CustomEditorEditRefusal
} from './plugin-custom-editor-host'

type PluginCustomEditorFrameProps = {
  editor: ActivePluginCustomEditor
  /** Text editors: the tab's file id; every save of it first flushes this frame. */
  fileId?: string
  content: string
  readOnly: boolean
  onContentChange: (content: string) => void
  onSave: (content: string) => Promise<boolean>
  /** Marks the tab dirty while the frame holds edits the buffer lacks. */
  onDirtyHint?: (dirty: boolean) => void
  /** Set for a binary editor: its bytes once loaded (null before). Text props are then unused. */
  binaryDocument?: CustomEditorBinaryDocument | null
}

type GuestState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'unresponsive' }
  | { status: 'ready'; ticket: PluginEditorGuestOpenResult }

function FrameMessage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * A plugin's editor for the open file. It runs as a `<webview>` guest in a partition with no
 * network, and only exchanges the document with this tab through main.
 */
export default function PluginCustomEditorFrame({
  editor,
  fileId,
  content,
  readOnly,
  onContentChange,
  onSave,
  onDirtyHint,
  binaryDocument
}: PluginCustomEditorFrameProps): React.JSX.Element {
  const [guest, setGuest] = useState<GuestState>({ status: 'loading' })
  const [refusal, setRefusal] = useState<CustomEditorEditRefusal | null>(null)
  const [saveBlocked, setSaveBlocked] = useState(false)
  const [loadedToken, setLoadedToken] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  // Why refs: the host is built once per guest; props change on every keystroke.
  const latestRef = useRef({
    content,
    readOnly,
    onContentChange,
    onSave,
    onDirtyHint,
    binaryDocument
  })
  latestRef.current = { content, readOnly, onContentChange, onSave, onDirtyHint, binaryDocument }
  const isBinary = binaryDocument !== undefined
  const ticket = guest.status === 'ready' ? guest.ticket : null
  const token = ticket?.token ?? null

  const { pluginKey, id: editorId } = editor
  useEffect(() => {
    let cancelled = false
    let current: PluginEditorGuestOpenResult | null = null
    const pluginsApi = window.api?.plugins
    const open = pluginsApi?.openCustomEditorGuest
    if (!pluginsApi || !open) {
      setGuest({ status: 'error' })
      return
    }
    setGuest({ status: 'loading' })
    const close = (closing: PluginEditorGuestOpenResult | null): void => {
      if (closing) {
        void pluginsApi.closeCustomEditorGuest?.(closing.token)
      }
    }
    const load = (): void => {
      open({
        pluginKey,
        editorId,
        colorScheme: currentPanelColorScheme(),
        tokens: buildPanelDesignTokenCss()
      })
        .then((opened) => {
          if (cancelled) {
            close(opened)
            return
          }
          if (!opened) {
            close(current)
            current = null
            setGuest({ status: 'error' })
            return
          }
          // Plugin list changes fire often; only new editor bytes remount the guest.
          if (current && opened.revision === current.revision) {
            close(opened)
            return
          }
          close(current)
          current = opened
          setGuest({ status: 'ready', ticket: opened })
        })
        .catch(() => {
          if (!cancelled) {
            close(current)
            current = null
            setGuest({ status: 'error' })
          }
        })
    }
    load()
    const unsubscribe = pluginsApi.onChanged ? pluginsApi.onChanged(load) : null
    return () => {
      cancelled = true
      unsubscribe?.()
      close(current)
    }
  }, [pluginKey, editorId])

  const deliver = useMemo(
    () =>
      (message: unknown): void => {
        // send throws until the guest attaches; the host only posts after the guest is ready.
        try {
          void webviewRef.current?.send(PLUGIN_EDITOR_GUEST_DELIVER_CHANNEL, message)
        } catch {
          // A detached guest has nothing to receive.
        }
      },
    []
  )

  const watchdog = useMemo(
    () =>
      createPanelWatchdog({
        sendPing: (pingId) => deliver({ type: PANEL_PING_TYPE, pingId }),
        onUnresponsive: () => setGuest({ status: 'unresponsive' })
      }),
    [deliver]
  )

  const editorReadOnly = ticket?.readonly ?? true
  const host = useMemo(() => {
    const created = createCustomEditorHost({
      post: (message) => deliver(message),
      getDocument: () => ({
        text: latestRef.current.content,
        readOnly: latestRef.current.readOnly
      }),
      editorReadOnly,
      ...(isBinary ? { getBinaryDocument: () => latestRef.current.binaryDocument ?? null } : {}),
      onEdit: (text) => {
        setRefusal(null)
        setSaveBlocked(false)
        latestRef.current.onContentChange(text)
      },
      onEditRefused: setRefusal,
      onUnappliedEdit: (state) => {
        if (state !== null) {
          latestRef.current.onDirtyHint?.(true)
        }
      },
      onPong: (pingId) => watchdog.handlePong(pingId)
    })
    return created
  }, [watchdog, isBinary, editorReadOnly, deliver])

  // The guest element is imperative: React must never recreate it on a render.
  useEffect(() => {
    const container = containerRef.current
    if (!ticket || !container) {
      return
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createElement('webview') makes Electron's WebviewTag in this renderer.
    const webview = document.createElement('webview') as Electron.WebviewTag
    webview.setAttribute('partition', PLUGIN_EDITOR_PARTITION)
    webview.setAttribute('title', editor.title)
    webview.className = 'flex min-h-0 w-full flex-1 border-0 bg-background'
    const onDomReady = (): void => {
      setLoadedToken(ticket.token)
      // The theme may have changed between opening the guest and it loading.
      deliver(pluginFrameThemeMessage())
    }
    webview.addEventListener('dom-ready', onDomReady)
    container.appendChild(webview)
    webview.setAttribute('src', ticket.src)
    webviewRef.current = webview
    return () => {
      webview.removeEventListener('dom-ready', onDomReady)
      host.reset()
      webviewRef.current = null
      moveFocusToRendererBeforeWebviewDetach(webview)
      webview.remove()
    }
  }, [ticket, editor.title, host, deliver])

  useEffect(() => {
    const subscribe = window.api?.plugins?.onCustomEditorGuestEvent
    if (!token || !subscribe) {
      return
    }
    return subscribe((event) => {
      if (event.token !== token) {
        return
      }
      if (event.kind === 'message') {
        host.handleMessage(event.data)
        return
      }
      // Real input only: main reads chords before the guest, so editor code cannot save.
      const chord = new KeyboardEvent('keydown', event.chord)
      if (latestRef.current.readOnly || !editorShortcutMatches('editor.save', chord)) {
        return
      }
      // The save pipeline flushes this frame first; see registerEditorFrameFlush below.
      void latestRef.current.onSave(host.currentText())
    })
  }, [token, host])

  useEffect(() => {
    if (!token || loadedToken !== token) {
      return
    }
    // Ping only once the guest document (and its pong responder) has loaded.
    watchdog.start()
    return () => watchdog.stop()
  }, [token, loadedToken, watchdog])

  const themeRevision = usePluginPanelThemeRevision()
  useEffect(() => {
    if (themeRevision > 0) {
      deliver(pluginFrameThemeMessage())
    }
  }, [themeRevision, deliver])

  useEffect(() => {
    host.syncDocument()
  }, [content, readOnly, binaryDocument, host])

  useEffect(() => {
    if (fileId === undefined || isBinary) {
      return
    }
    return registerEditorFrameFlush(fileId, async () => {
      const flushed = await host.flush()
      setSaveBlocked(!flushed)
      return flushed
    })
  }, [fileId, isBinary, host])

  if (guest.status === 'loading') {
    return (
      <FrameMessage>
        {translate('auto.components.editor.PluginCustomEditorFrame.loading', 'Loading editor…')}
      </FrameMessage>
    )
  }
  if (guest.status === 'unresponsive') {
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
  if (guest.status === 'error') {
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
      <div ref={containerRef} className="flex min-h-0 flex-1" />
    </div>
  )
}
