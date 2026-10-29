import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import {
  nativeChatTextAttachmentParts,
  chatTextAttachmentName
} from '../../../../shared/native-chat-text-attachment-references'
import { NativeChatTextAttachmentPreview } from './NativeChatTextAttachmentPreview'
import { useNativeChatImageRuntimeContext } from './native-chat-image-runtime-context'

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
  return (
    <AttachmentScopeForOwner key={JSON.stringify(context)} context={context}>
      {children}
    </AttachmentScopeForOwner>
  )
}

function AttachmentScopeForOwner({
  context,
  children
}: {
  context: RuntimeFileOperationArgs | null
  children: ReactNode
}) {
  const [selected, setSelected] = useState<{ path: string; text?: string } | null>(null)
  const open = useCallback((path: string, text?: string) => setSelected({ path, text }), [])
  return (
    <NativeChatTextAttachmentOpener.Provider value={open}>
      {children}
      {selected ? (
        <NativeChatTextAttachmentPreview
          key={JSON.stringify([selected.path, context])}
          {...selected}
          target={context?.target ?? null}
          onClose={() => setSelected(null)}
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
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => (opener ? opener(path) : setOpen(true))}
      >
        {chatTextAttachmentName(path)}
      </Button>
      {open ? (
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
  if (!structured) {
    return <>{renderText(content)}</>
  }
  return (
    <>
      {nativeChatTextAttachmentParts(content, structured).map((part, index) => (
        <div key={index}>
          {part.path ? (
            <AttachmentButton
              key={JSON.stringify(runtimeContext)}
              path={part.path}
              runtimeContext={runtimeContext}
            />
          ) : (
            renderText(part.text)
          )}
        </div>
      ))}
    </>
  )
}
