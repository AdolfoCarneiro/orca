// @vitest-environment happy-dom
import { StrictMode, useContext, useState } from 'react'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  NativeChatTextAttachments,
  NativeChatTextAttachmentScope,
  NativeChatTextAttachmentOpener
} from './NativeChatTextAttachments'
import { NativeChatTextAttachmentPreview } from './NativeChatTextAttachmentPreview'
import { AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY } from '../../../../shared/agent-session-runtime-capabilities'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

const mocks = vi.hoisted(() => ({
  context: null as RuntimeFileOperationArgs | null,
  web: false,
  rpc: vi.fn(),
  write: vi.fn(),
  start: vi.fn(),
  append: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('./native-chat-image-runtime-context', () => ({
  useNativeChatImageRuntimeContext: () => mocks.context
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
const path =
  '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/orca-paste-123-abc.txt'
const target = { kind: 'environment', environmentId: 'env-text' } as const
const bytes = Buffer.from(['\ufeffstart\r\n', '🙂'.repeat(20_000), 'end'].join(''))
let capable = true

beforeEach(() => {
  capable = true
  mocks.context = null
  mocks.web = false
  mocks.cancel.mockReset().mockResolvedValue(undefined)
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

it('opens and copies the live paste before upload even while its host route is unresolved', async () => {
  const text = '\ufefflive\r\n'.concat('🙂'.repeat(10_000))
  render(<NativeChatTextAttachmentPreview path="" text={text} target={null} onClose={() => {}} />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
      false
    )
  )
  fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(text))
  expect(mocks.rpc).not.toHaveBeenCalled()
})

it('cancels a source during status admission and lets a newly opened successor read', async () => {
  const { AttachmentTextSource } = await import('../../../../shared/attachment-text-source')
  const { createChatAttachmentReader } = await import('./native-chat-text-attachment-read')
  for (const count of [1, 10]) {
    const gates = Array.from({ length: count }, () => Promise.withResolvers<unknown>())
    const started = Promise.withResolvers<void>()
    let probes = 0
    const normal = mocks.rpc.getMockImplementation()!
    mocks.rpc.mockImplementation((...args) => {
      if (args[1] === 'status.get' && probes < count) {
        const gate = gates[probes++]!
        if (probes === count) {
          started.resolve()
        }
        return gate.promise
      }
      return normal(...args)
    })
    const sources = gates.map(
      () => new AttachmentTextSource(path, createChatAttachmentReader(target))
    )
    const pending = sources.map((source) =>
      source.page(0).then(
        () => false,
        () => true
      )
    )
    await started.promise
    sources.forEach((source) => source.dispose())
    const before = mocks.rpc.mock.calls.filter((call) => call[1] !== 'status.get').length
    gates.forEach((gate) =>
      gate.resolve({ capabilities: [AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY] })
    )
    expect(await Promise.all(pending)).toEqual(Array(count).fill(true))
    expect(mocks.rpc.mock.calls.filter((call) => call[1] !== 'status.get')).toHaveLength(before)
    const successor = new AttachmentTextSource(path, createChatAttachmentReader(target))
    expect(await successor.copyText()).toBe(bytes.toString('utf8'))
    mocks.rpc.mockImplementation(normal)
  }
})

it.each([true, false])(
  'keeps focused stateful composer descendants mounted when owner context changes (structured=%s)',
  async (enabled) => {
    mocks.context = { target: { kind: 'local' }, worktreeId: 'w', worktreePath: '/repo' }
    function Child() {
      const [value, setValue] = useState('')
      const open = useContext(NativeChatTextAttachmentOpener)
      return (
        <>
          <input
            aria-label="draft"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button onClick={() => open?.(path)}>Open source</button>
        </>
      )
    }
    const ui = () => (
      <NativeChatTextAttachmentScope enabled={enabled} tabId="tab">
        <Child />
      </NativeChatTextAttachmentScope>
    )
    const view = render(ui())
    const input = screen.getByRole('textbox', { name: 'draft' })
    fireEvent.change(input, { target: { value: 'local editor state' } })
    input.focus()
    mocks.context = { ...mocks.context, worktreePath: '/renamed' }
    view.rerender(ui())
    expect(screen.getByRole('textbox', { name: 'draft', hidden: true })).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('value')).toBe('local editor state')
    if (!enabled) {
      expect(mocks.rpc).not.toHaveBeenCalled()
      return
    }
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
        false
      )
    )
    const gate = Promise.withResolvers<unknown>()
    const normal = mocks.rpc.getMockImplementation()!
    mocks.rpc.mockImplementationOnce(() => gate.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
    await act(async () => {})
    mocks.context = { ...mocks.context, expectedSshConnectionGeneration: 2 }
    view.rerender(ui())
    expect(screen.queryByRole('button', { name: 'Copy contents' })).toBeNull()
    await act(async () =>
      gate.resolve(
        await normal(target, 'agentSessionAttachment.readTextChunk', {
          offset: 0,
          length: bytes.length
        })
      )
    )
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open source' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
        false
      )
    )
    expect(screen.getByRole('textbox', { name: 'draft', hidden: true })).toBe(input)
    const picker = Promise.withResolvers<{ canceled: false; transferId: string }>()
    mocks.start.mockReturnValueOnce(picker.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await act(async () => {})
    mocks.context = { ...mocks.context, worktreePath: '/changed-again' }
    view.rerender(ui())
    await act(async () => picker.resolve({ canceled: false, transferId: 'late-output' }))
    expect(mocks.cancel).toHaveBeenCalledWith({ transferId: 'late-output' })
    expect(mocks.append).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
  }
)

it('exports all raw web bytes and cancels desktop picker/output failures', async () => {
  mocks.web = true
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:35636')
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const view = render(
    <NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />
  )
  const save = () => screen.getByRole('button', { name: 'Save file' })
  await waitFor(() => expect(save().hasAttribute('disabled')).toBe(false))
  fireEvent.click(save())
  await waitFor(() => expect(click).toHaveBeenCalledOnce())
  const blob = create.mock.calls[0]![0]
  if (!(blob instanceof Blob)) {
    throw new Error('Expected a complete file Blob')
  }
  expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes)
  expect(mocks.start).not.toHaveBeenCalled()
  create.mockRestore()
  click.mockRestore()
  view.unmount()
  mocks.web = false
  mocks.start.mockResolvedValueOnce({ canceled: true })
  render(<NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />)
  await waitFor(() => expect(save().hasAttribute('disabled')).toBe(false))
  fireEvent.click(save())
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
  await waitFor(() => expect(save().hasAttribute('disabled')).toBe(false))
  expect(mocks.append).not.toHaveBeenCalled()
  expect(mocks.finish).not.toHaveBeenCalled()
  mocks.append.mockRejectedValueOnce(new Error('Output failed'))
  fireEvent.click(save())
  await screen.findByText('Output failed')
  expect(mocks.cancel).toHaveBeenCalledWith({ transferId: 'output' })
  expect(mocks.finish).not.toHaveBeenCalled()
})
