// @vitest-environment happy-dom
import { createRef, useRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { NativeChatTextAttachmentScope } from './NativeChatTextAttachments'
import { NativeChatUserMessageRow } from './NativeChatUserMessageRow'
import { useNativeChatPastedTextFile } from './use-native-chat-pasted-text-file'
import {
  insertNativeChatPastedText,
  type NativeChatComposerInput
} from './native-chat-composer-input'
import { promptEditor, promptValue } from './native-chat-prompt-editor.test-support'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { resolveNativeChatPastedText } from './native-chat-composer-pasted-text-references'
import { nativeChatPastedTextOperations } from './native-chat-pasted-text-reference'
import { nativeChatSentPrompts } from './native-chat-sent-prompt-history'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

const mocks = vi.hoisted(() => ({ save: vi.fn(), rpc: vi.fn(), write: vi.fn() }))
vi.mock('./native-chat-image-runtime-context', () => ({
  useNativeChatImageRuntimeContext: () => ({
    target: { kind: 'local' },
    worktreeId: 'w',
    worktreePath: '/repo'
  })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('./native-chat-visual-markdown-extension', () => ({
  useNativeChatVisualMarkdownExtension: () => undefined
}))
vi.mock('./use-native-chat-file-link-existence', () => ({
  useNativeChatFileLinkExists: () => undefined
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
const scope = 'agent-session:consumer35636'
const path =
  '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/orca-paste-123-abc.txt'
let paste: (text: string) => boolean
let input: NativeChatComposerInput | null
function Composer({ initialValue = '' }: { initialValue?: string }) {
  const ref = useRef<NativeChatComposerInput>(null)
  paste = useNativeChatPastedTextFile({
    scopeKey: scope,
    scopeEditor: () => ref.current,
    resolveAttachmentOwner: () => ({ kind: 'local' }),
    insertTypedText: (text) => insertNativeChatPastedText(ref.current, text),
    setNotice: () => {}
  })
  return (
    <NativeChatTextAttachmentScope enabled tabId="tab">
      <NativeChatPromptEditor
        scopeKey={scope}
        inputRef={ref}
        initialValue={initialValue}
        disabled={false}
        placeholder="Message"
        onChange={(current) => {
          input = current
        }}
        onSelect={() => {}}
      />
    </NativeChatTextAttachmentScope>
  )
}
function row(text: string) {
  const message: NativeChatMessage = {
    id: 'sent35636',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text }]
  }
  const derived = deriveNativeChatRowContent(message.blocks)
  return {
    message,
    element: (
      <TooltipProvider>
        <NativeChatUserMessageRow
          message={message}
          markdown={derived.markdown}
          prose={derived.prose}
          rowRef={createRef()}
          onRefolded={() => {}}
          allowFileUriLinks
          structuredAttachments
          runtimeContext={{ target: { kind: 'local' }, worktreeId: 'w', worktreePath: '/repo' }}
        />
      </TooltipProvider>
    )
  }
}
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  nativeChatPastedTextOperations.clear()
  vi.clearAllMocks()
})

it('opens pending and settled draft pills, retains remove/undo, restores the token map and renders sent/recall references as source actions', async () => {
  const text = '🙂paste\r\n'.repeat(5000)
  const upload = Promise.withResolvers<string>()
  mocks.save.mockReturnValue(upload.promise)
  mocks.rpc.mockImplementation(async (_target, method, request) => {
    if (method === 'status.get') {
      return { capabilities: ['native-chat.text-attachment-read.v1'] }
    }
    const bytes = Buffer.from(text)
    const chunk = bytes.subarray(request.offset, request.offset + request.length)
    return {
      snapshot: 'a'.repeat(64),
      size: bytes.length,
      bytesRead: chunk.length,
      contentBase64: chunk.toString('base64'),
      eof: request.offset + chunk.length === bytes.length
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { savePastedTextAsFile: mocks.save, writeClipboardText: mocks.write } }
  })
  let view = render(<Composer />)
  await act(async () => {
    expect(paste(text)).toBe(true)
  })
  expect(screen.getByRole('button', { name: 'Pasted text' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Pasted text' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
      false
    )
  )
  fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(text))
  expect(mocks.rpc).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await act(async () => upload.resolve(path))
  expect(nativeChatPastedTextOperations.size).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Pasted text' }))
  await waitFor(() =>
    expect(mocks.rpc).toHaveBeenCalledWith(
      expect.anything(),
      'agentSessionAttachment.readTextChunk',
      expect.objectContaining({ path }),
      expect.anything()
    )
  )
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  const editor = promptEditor(screen.getByRole('textbox'))
  const token = promptValue(screen.getByRole('textbox')).trim()
  act(() => {
    editor.commands.selectAll()
    editor.commands.deleteSelection()
  })
  expect(screen.queryByRole('button', { name: 'Pasted text' })).toBeNull()
  await act(async () => {
    editor.commands.undo()
  })
  expect(screen.getByRole('button', { name: 'Pasted text' })).toBeTruthy()
  const saved = structuredClone(readNativeChatComposerDraft(scope))
  expect(saved.text).toContain(token)
  const sent = resolveNativeChatPastedText(scope, token)
  const body = structuredAgentSessionSendBody(sent, [])
  expect(body.blocks).toEqual([{ type: 'text', text: sent }])
  expect(sent).toBe(`@${path}`)
  view.unmount()
  clearNativeChatComposerDraftsForTests()
  updateNativeChatComposerDraft(
    scope,
    { text: saved.text, document: saved.document, pastedTextFiles: saved.pastedTextFiles },
    'immediate'
  )
  expect(readNativeChatComposerDraft(scope).text).toBe(saved.text)
  view = render(<Composer initialValue={saved.text} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Pasted text' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
      false
    )
  )
  view.unmount()
  const sentRow = row(sent)
  expect(nativeChatSentPrompts({ messages: [sentRow.message] })).toEqual([
    { id: sentRow.message.id, prompt: sent }
  ])
  view = render(sentRow.element)
  fireEvent.click(screen.getByRole('button', { name: 'Pasted text' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
      false
    )
  )
  view.unmount()
  const recalled = nativeChatSentPrompts({ messages: [sentRow.message] })[0]!.prompt
  render(row(recalled).element)
  expect(screen.getByRole('button', { name: 'Pasted text' })).toBeTruthy()
})

it('keeps a committed picked filename actionable through the existing editor insertion', async () => {
  render(<Composer />)
  const picked = path.replace(/orca-paste-[^/]+$/, 'report.csv')
  const editor = promptEditor(screen.getByRole('textbox'))
  act(() => {
    editor.commands.focus()
    editor.commands.insertContent('see ')
  })
  await act(async () => input!.insertFileReferences!([picked]))
  expect(screen.getByRole('button', { name: 'report.csv' })).toBeTruthy()
  expect(input!.value).toContain(`@${picked}`)
})
