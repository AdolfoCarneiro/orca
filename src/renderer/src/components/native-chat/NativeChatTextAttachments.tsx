import { createContext, useCallback, useContext, useState, useMemo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import {
  nativeChatTextAttachmentPaths,
  chatTextAttachmentName
} from '../../../../shared/native-chat-text-attachment-references'
import { NativeChatTextAttachmentPreview } from './NativeChatTextAttachmentPreview'
import { useNativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'

export const NativeChatTextAttachmentOpener = createContext<
  ((path: string, text?: string) => void) | null
>(null)

export function NativeChatTextAttachmentScope({
  tabId,
  enabled,
  children
}: {
  tabId: string
  enabled: boolean
  children: ReactNode
}) {
  return enabled ? (
    <StructuredAttachmentScope tabId={tabId}>{children}</StructuredAttachmentScope>
  ) : (
    <>{children}</>
  )
}

function StructuredAttachmentScope({ tabId, children }: { tabId: string; children: ReactNode }) {
  const context = useNativeChatImageRuntimeContext(tabId)
  const visible = useContext(NativeChatMarkdownImageOwnerContext)?.isVisible ?? true
  const owner = JSON.stringify(context)
  const [selection, setSelection] = useState<{
    owner: string
    path: string
    text?: string
  } | null>(null)
  // Only the preview retires when its chat hides or changes owner; the editor stays mounted.
  if (selection && (selection.owner !== owner || !visible)) {
    setSelection(null)
  }
  const selected = visible && selection?.owner === owner ? selection : null
  const open = useCallback(
    (path: string, text?: string) => {
      if (visible) {
        setSelection({ owner, path, text })
      }
    },
    [owner, visible]
  )
  return (
    <NativeChatTextAttachmentOpener.Provider value={open}>
      {children}
      {selected ? (
        <NativeChatTextAttachmentPreview
          key={JSON.stringify([selected.path, context])}
          {...selected}
          target={context?.target ?? null}
          onClose={() => setSelection(null)}
        />
      ) : null}
    </NativeChatTextAttachmentOpener.Provider>
  )
}

function AttachmentButton({
  path,
  runtimeContext
}: {
  path: string
  runtimeContext?: RuntimeFileOperationArgs | null
}) {
  const [open, setOpen] = useState(false)
  const opener = useContext(NativeChatTextAttachmentOpener)
  const visible = useContext(NativeChatMarkdownImageOwnerContext)?.isVisible ?? true
  if (open && !visible) {
    setOpen(false)
  }
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => visible && (opener ? opener(path) : setOpen(true))}
      >
        {chatTextAttachmentName(path)}
      </Button>
      {open && visible ? (
        <NativeChatTextAttachmentPreview
          path={path}
          target={runtimeContext?.target ?? null}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

export function NativeChatTextAttachments({
  content,
  structured,
  runtimeContext,
  renderText
}: {
  content: string
  structured: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  renderText: (text: string) => ReactNode
}) {
  const paths = useMemo(
    () => (structured ? nativeChatTextAttachmentPaths(content) : []),
    [content, structured]
  )
  return (
    <>
      {renderText(content)}
      {paths.map((path) => (
        <AttachmentButton
          key={JSON.stringify([path, runtimeContext])}
          path={path}
          runtimeContext={runtimeContext}
        />
      ))}
    </>
  )
}
