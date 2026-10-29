import { createElement } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { useMobileFileTapHandlers } from '../session/use-mobile-file-tap-handlers'
import { MobileNativeChatComposerAttachments } from '../session/native-chat/composer/MobileNativeChatComposerAttachments'
import { normalizeMobileFilePreviewRouteParams } from './mobile-file-preview-route'
import { MobileFilePreviewScreen } from './MobileFilePreviewScreen'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  write: vi.fn(),
  send: vi.fn(),
  generation: 1
}))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  Image: 'Image',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 })
}))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  Save: 'Icon',
  FileText: 'Icon',
  Image: 'Icon',
  X: 'Icon'
}))
vi.mock('../navigation/workspace-route-handoff', () => ({
  useWorkspaceRouteHandoff: () => ({ push: mocks.push, back: mocks.back })
}))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText: mocks.write }) }))
vi.mock('../platform/haptics', () => ({ triggerSelection: vi.fn() }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./MobileFilePreviewBody', () => ({ MobileFilePreviewBody: () => null }))
vi.mock('../transport/host-client-hooks', () => ({ useForceReconnect: () => vi.fn() }))
const client = {
  sendRequest: (...args: unknown[]) => mocks.send(...args),
  getState: () => 'connected' as const,
  getLastConnectedAt: () => 1,
  getGeneration: () => mocks.generation
}
vi.mock('../transport/use-workspace-client', () => ({
  useWorkspaceClient: () => ({ client, state: 'connected' })
}))
const path = '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/report.txt'
let tree: ReactTestRenderer | null = null
const textIn = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textIn).join('')
const button = (label: string) =>
  tree!.root.find((node) => String(node.type) === 'Pressable' && textIn(node) === label)
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.clearAllMocks()
})

it('opens a committed phone card through the file-tap route into the shipping preview and copies the complete source', async () => {
  const text = '\ufefffirst\r\n' + '🙂'.repeat(10_000) + 'last'
  const bytes = Buffer.from(text)
  mocks.send.mockImplementation(
    async (method: string, request?: { offset: number; length: number }): Promise<RpcResponse> => {
      if (method === 'status.get') {
        return {
          id: 's',
          ok: true,
          result: { capabilities: ['native-chat.text-attachment-read.v1'] }
        }
      }
      if (!request) {
        throw new Error('Missing range')
      }
      const chunk = bytes.subarray(request.offset, request.offset + request.length)
      return {
        id: 'r',
        ok: true,
        result: {
          snapshot: 'a'.repeat(64),
          size: bytes.length,
          bytesRead: chunk.length,
          contentBase64: chunk.toString('base64'),
          eof: request.offset + chunk.length === bytes.length
        }
      }
    }
  )
  function Card() {
    const handlers = useMobileFileTapHandlers({
      client,
      hostId: 'owner',
      worktreeId: 'folder:work',
      worktreeName: 'Work',
      nativeChatSessionId: 's',
      structuredAttachments: true,
      activeHandleRef: { current: null },
      terminalCwdRef: { current: new Map() },
      openBrowser: vi.fn(),
      fetchSessionTabs: async () => {},
      getSessionTabs: () => [],
      getActiveSessionTabId: () => 'chat',
      getActiveSessionTabType: () => 'agent-session',
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn(),
      reportChatTapFailure: vi.fn()
    })
    return createElement(MobileNativeChatComposerAttachments, {
      images: [],
      files: [
        { id: 'file', name: 'report.txt', mime: 'text/plain', byteLength: bytes.length, path }
      ],
      onOpenFile: handlers.handleNativeChatFileTap
    })
  }
  await act(async () => {
    tree = create(createElement(Card))
  })
  expect(mocks.send).not.toHaveBeenCalled()
  const card = tree!.root.find(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'button'
  )
  act(() => card.props.onPress())
  expect(mocks.push).toHaveBeenCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({
        hostId: 'owner',
        absolutePath: path,
        source: 'chatAttachment'
      })
    })
  )
  const route = normalizeMobileFilePreviewRouteParams(mocks.push.mock.calls[0]![0].params)
  await act(async () => {
    tree!.update(createElement(MobileFilePreviewScreen, { route }))
  })
  expect(button('Copy').props.disabled).toBe(false)
  expect(button('Save').props.disabled).toBe(true)
  await act(async () => button('Copy').props.onPress())
  expect(mocks.write).toHaveBeenCalledWith(text)
  expect(
    mocks.send.mock.calls.some(([method]) => method === 'agentSessionAttachment.readTextChunk')
  ).toBe(true)
})

it('refuses escaped full Copy that exceeds the phone frame and never copies the page', async () => {
  const bytes = Buffer.from('\u0001'.repeat(120_000))
  mocks.send.mockImplementation(
    async (method: string, request?: { offset: number; length: number }): Promise<RpcResponse> => {
      if (method === 'status.get') {
        return {
          id: 's',
          ok: true,
          result: { capabilities: ['native-chat.text-attachment-read.v1'] }
        }
      }
      if (!request) {
        throw new Error('Missing range')
      }
      const chunk = bytes.subarray(request.offset, request.offset + request.length)
      return {
        id: 'r',
        ok: true,
        result: {
          snapshot: 'a'.repeat(64),
          size: bytes.length,
          bytesRead: chunk.length,
          contentBase64: chunk.toString('base64'),
          eof: request.offset + chunk.length === bytes.length
        }
      }
    }
  )
  const route = normalizeMobileFilePreviewRouteParams({
    hostId: 'owner',
    worktreeId: 'work',
    source: 'chatAttachment',
    absolutePath: path
  })
  await act(async () => {
    tree = create(createElement(MobileFilePreviewScreen, { route }))
  })
  expect(button('Copy').props.disabled).toBe(false)
  await act(async () => button('Copy').props.onPress())
  expect(mocks.write).not.toHaveBeenCalled()
  expect(
    tree!.root
      .findAll((node) => node.props.accessibilityRole === 'alert')
      .map(textIn)
      .join('')
  ).toContain('Full Copy for this attachment needs the upcoming phone update')
})
