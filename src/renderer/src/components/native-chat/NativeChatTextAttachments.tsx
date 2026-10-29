import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { createContext, useCallback, useContext, useState, useMemo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import {
  nativeChatTextAttachmentPaths,
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
  const owner = JSON.stringify(context)
  const [selection, setSelection] = useState<{
    owner: string
    path: string
    text?: string
  } | null>(null)
  // A changed owner cancels only the preview; the editor and its focus stay mounted.
  if (selection && selection.owner !== owner) {
    setSelection(null)
  }
  const selected = selection?.owner === owner ? selection : null
  const open = useCallback(
    (path: string, text?: string) => setSelection({ owner, path, text }),
    [owner]
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

const attachmentMarkdown = unified().use(remarkParse).use(remarkGfm)

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
    () => (structured ? nativeChatTextAttachmentPaths(attachmentMarkdown.parse(content)) : []),
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
