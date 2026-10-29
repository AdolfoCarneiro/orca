// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeChatTextAttachments } from './NativeChatTextAttachments'
import { NativeChatTextAttachmentPreview } from './NativeChatTextAttachmentPreview'
import { AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY } from '../../../../shared/agent-session-runtime-capabilities'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  write: vi.fn(),
  start: vi.fn(),
  append: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('./native-chat-image-runtime-context', () => ({
  useNativeChatImageRuntimeContext: () => null
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
const path =
  '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/orca-paste-123-abc.txt'
const target = { kind: 'environment', environmentId: 'env-text' } as const
const bytes = Buffer.from(['\ufeffstart\r\n', '🙂'.repeat(20_000), 'end'].join(''))
let capable = true

beforeEach(() => {
  capable = true
  replaceRuntimeEnvironmentRevisions([{ id: 'env-text', createdAt: 1 }])
  mocks.rpc.mockReset().mockImplementation(async (_target, method, request) => {
    if (method === 'status.get') {
      return {
        runtimeId: 'host-1',
        capabilities: capable ? [AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY] : []
      }
    }
    const chunk = bytes.subarray(request.offset, request.offset + request.length)
    return {
      snapshot: 'a'.repeat(64),
      size: bytes.length,
      contentBase64: chunk.toString('base64'),
      bytesRead: chunk.length,
      eof: request.offset + chunk.length === bytes.length
    }
  })
  mocks.write.mockReset().mockResolvedValue(undefined)
  mocks.start.mockReset().mockResolvedValue({ canceled: false, transferId: 'output' })
  mocks.append.mockReset().mockResolvedValue(undefined)
  mocks.finish.mockReset().mockResolvedValue({ canceled: false })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { writeClipboardText: mocks.write },
      fs: {
        startDownloadedFile: mocks.start,
        appendDownloadedFileChunk: mocks.append,
        finishDownloadedFile: mocks.finish,
        cancelDownloadedFile: mocks.cancel
      }
    }
  })
})
afterEach(cleanup)

it('keeps terminal text unchanged and does no body reads until a structured reference is opened', async () => {
  const content = `Read @${path}`
  const renderText = (text: string) => <span>{text}</span>
  const view = render(
    <NativeChatTextAttachments content={content} structured={false} renderText={renderText} />
  )
  expect(screen.queryByRole('button')).toBeNull()
  expect(view.container.textContent).toBe(content)
  view.rerender(
    <NativeChatTextAttachments
      content={content}
      structured
      runtimeContext={{ target, worktreeId: 'w', worktreePath: '/repo' }}
      renderText={renderText}
    />
  )
  expect(mocks.rpc).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Pasted text' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
      false
    )
  )
  expect(
    mocks.rpc.mock.calls.filter((call) => call[1] === 'agentSessionAttachment.readTextChunk')
  ).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(bytes.toString('utf8')))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save file' }).hasAttribute('disabled')).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  await waitFor(() => expect(mocks.finish).toHaveBeenCalled())
  expect(
    Buffer.concat(
      mocks.append.mock.calls.map(([args]) => Buffer.from(args.contentBase64, 'base64'))
    )
  ).toEqual(bytes)
})

it('shows the old-host limitation and refreshes capability on Retry without affecting the message', async () => {
  capable = false
  render(<NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />)
  await screen.findByText(/This host cannot open text attachments yet/)
  expect(mocks.rpc.mock.calls.every((call) => call[1] === 'status.get')).toBe(true)
  capable = true
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
      false
    )
  )
})

it('survives StrictMode cleanup and refuses clipboard publication after the owner is re-paired', async () => {
  render(
    <StrictMode>
      <NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />
    </StrictMode>
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
      false
    )
  )
  let release!: () => void
  let started!: () => void
  const reading = new Promise<void>((resolve) => {
    started = resolve
  })
  mocks.rpc.mockImplementationOnce(async (_target, _method, request) => {
    started()
    await new Promise<void>((resolve) => {
      release = resolve
    })
    const chunk = bytes.subarray(request.offset, request.offset + request.length)
    return {
      snapshot: 'a'.repeat(64),
      size: bytes.length,
      contentBase64: chunk.toString('base64'),
      bytesRead: chunk.length,
      eof: true
    }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
  await reading
  await act(async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-text', createdAt: 2 }])
    release()
  })
  expect(mocks.write).not.toHaveBeenCalled()
})
