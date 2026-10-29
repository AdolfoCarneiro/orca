// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from './native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/slices/store-test-helpers'
import { NativeChatUserMessageRow } from './NativeChatUserMessageRow'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { AGENT_SESSION_WRITE_NOTICE_COPY } from '../../../../shared/agent-session-write-notice-copy'
import * as markdown from './NativeChatMarkdown'
import * as display from '../../../../shared/agent-session/agent-message-display-text'
import * as grammar from '../../../../shared/orca-dispatch-status-prompt'
import * as prose from '../../../../shared/native-chat/transcript/native-chat-prose'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import { nativeChatSlotCopyText } from './native-chat-message-copy-text'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'

const navigation = vi.hoisted(() => ({ rpc: vi.fn(), gone: vi.fn(), toast: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: navigation.rpc
}))
vi.mock('@/components/terminal-pane/stale-agent-row', () => ({
  showAgentPaneUnavailable: navigation.gone
}))
vi.mock('sonner', () => ({ toast: { error: navigation.toast } }))
const initialStore = useAppStore.getState()
let height = 48
let resize: () => void
let disconnects = 0
let measurements = 0
beforeEach(() => {
  useAppStore.setState(
    {
      ...initialStore,
      activeWorktreeId: 'wt-chat',
      activeWorkspaceExecutionHostId: 'local',
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      tabsByWorktree: {},
      unifiedTabsByWorktree: {}
    },
    true
  )
  navigation.rpc.mockReset()
  navigation.gone.mockReset()
  navigation.toast.mockReset()
  height = 48
  disconnects = 0
  measurements = 0
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => {
    measurements++
    return height
  })
  const computedStyle = getComputedStyle
  vi.stubGlobal('getComputedStyle', (element: Element) => {
    const style = computedStyle(element)
    return new Proxy(style, {
      get(target, key) {
        if (key === 'lineHeight') {
          return '24px'
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the style facade delegates native properties to the real style receiver, including binding its methods below.
        const value = target[key as keyof CSSStyleDeclaration]
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect() {
        disconnects++
      }
    }
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function source(relation?: 'worker' | 'coordinator' | 'none'): AgentMessageSource {
  return {
    kind: 'agent',
    orchestration: {
      message: 'mail-notice',
      mailbox: 'term_recipient',
      dispatchId: null,
      messages: []
    },
    senders: [
      {
        party: { address: 'term_sender', terminalHandle: 'term_sender', orcaSessionId: null },
        name: 'Build cards',
        ...(relation ? { relation } : {})
      }
    ]
  }
}
function card(from = source(), text = 'Short message') {
  const message: NativeChatMessage = {
    id: 'm',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text }],
    from
  }
  return (
    <NativeChatAgentMessageCard
      message={message}
      from={from}
      runtimeContext={{ worktreeId: 'wt-chat', worktreePath: null, target: { kind: 'local' } }}
      allowFileUriLinks={false}
      onRefolded={() => {}}
    />
  )
}

function slots(message: NativeChatMessage) {
  return buildNativeChatTranscriptSlots({
    messages: [message],
    turnKeys: [undefined],
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false
  })
}

it('opens distinct named local senders without status and preserves real gone/unreachable/older-host feedback', async () => {
  const from = source('worker')
  const session = testOrcaSessionId('other-sender')
  const second = {
    party: { address: `orca_session_id:${session}`, terminalHandle: null, orcaSessionId: session },
    name: 'Other sender'
  }
  render(
    card({
      ...from,
      senders: [
        ...from.senders,
        second,
        {
          ...from.senders[0],
          party: { ...from.senders[0].party, address: 'dispatch:foreign' },
          name: 'Remote'
        }
      ]
    })
  )
  navigation.rpc.mockResolvedValueOnce({ location: null, lost: 'terminal' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Build cards' })))
  expect(navigation.gone).toHaveBeenCalledTimes(1)
  expect(navigation.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'orchestration.partyLocation', {
    address: 'term_sender'
  })
  navigation.rpc.mockRejectedValueOnce(new Error('unreachable'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Other sender' })))
  expect(navigation.toast).toHaveBeenLastCalledWith(
    `${AGENT_SESSION_WRITE_NOTICE_COPY.unreachable} ${AGENT_SESSION_WRITE_NOTICE_COPY.tryAgain}`
  )
  navigation.rpc.mockRejectedValueOnce(
    new RuntimeRpcCallError({
      id: 'lookup',
      ok: false,
      error: { code: 'method_not_found', message: 'old' },
      _meta: { runtimeId: 'fixture' }
    })
  )
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Other sender' })))
  expect(navigation.toast).toHaveBeenLastCalledWith(AGENT_SESSION_WRITE_NOTICE_COPY.unsupported)
  expect(screen.getByText('Remote').closest('button')).toBeNull()
})

it.each([10, 100])(
  'shows only the task spec and bounds %i resize notifications, including width changes',
  async (notifications) => {
    const prefix = 'You are working inside Orca, a multi-agent IDE.\n=== TASK ===\n'
    const from: AgentMessageSource = {
      ...source('coordinator'),
      orchestration: {
        message: 'task',
        runId: 'r',
        taskId: 't',
        dispatchId: 'd'
      }
    }
    const writeClipboardText = vi.fn(async () => {})
    vi.stubGlobal('api', { ui: { writeClipboardText } })
    const mounted = render(card(from, `${prefix}Build the cards`))
    expect(screen.getByText('Task from your coordinator')).toBeInTheDocument()
    expect(screen.getByText('Build the cards')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Worker instructions/)).not.toBeInTheDocument()
    const copy = screen.getByRole('button', { name: 'Copy message' })
    act(() => {
      height = 120
      resize()
    })
    await act(async () => fireEvent.click(copy))
    expect(writeClipboardText).toHaveBeenCalledWith('Build the cards')
    expect(screen.getByRole('button', { name: 'Copied' })).toBe(copy)
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    act(() => {
      height = 48
      resize()
    })
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
    const before = measurements
    for (let i = 0; i < notifications; i++) {
      act(() => resize())
    }
    expect(measurements - before).toBe(notifications)
    writeClipboardText.mockClear()
    await act(async () => fireEvent.click(copy))
    expect(writeClipboardText).toHaveBeenCalledWith('Build the cards')
    const task: NativeChatMessage = {
      id: 'task-copy',
      role: 'user',
      source: 'transcript',
      timestamp: 1,
      from,
      blocks: [{ type: 'text', text: `${prefix}Build the cards` }]
    }
    expect(nativeChatSlotCopyText(slots(task), task.id)).toBe('Build the cards')
    mounted.unmount()
    expect(disconnects).toBe(1)
  }
)

it('renders real Markdown paragraphs and links and preserves the direct and slot Copy boundary', async () => {
  const text =
    'First paragraph with [a link](https://example.com) and ![image](https://example.com/image.png).\n\nSecond paragraph.'
  const from = source()
  const message: NativeChatMessage = {
    id: 'paragraphs',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    from,
    blocks: [
      { type: 'text', text: text.split('\n\n')[0] },
      { type: 'text', text: '' },
      { type: 'text', text: 'Second paragraph.' },
      {
        type: 'image-ref',
        path: '/attachment.png',
        url: 'data:image/png;base64,iVBORw0KGgo=',
        alt: 'Attachment'
      }
    ]
  }
  const writeClipboardText = vi.fn(async () => {})
  vi.stubGlobal('api', { ui: { writeClipboardText } })
  vi.stubGlobal('IntersectionObserver', undefined)
  const mounted = render(
    <NativeChatUserMessageRow
      message={message}
      markdown={text}
      prose={message.blocks}
      runtimeContext={{ worktreeId: 'wt-chat', worktreePath: null, target: { kind: 'local' } }}
      rowRef={{ current: null }}
      allowFileUriLinks={false}
      onRefolded={() => {}}
    />
  )
  expect(screen.getByRole('img', { name: 'Attachment' })).toHaveAttribute(
    'src',
    'data:image/png;base64,iVBORw0KGgo='
  )
  expect(mounted.container.querySelectorAll('p')).toHaveLength(2)
  expect(screen.getByRole('link', { name: 'a link' })).toHaveAttribute(
    'href',
    'https://example.com'
  )
  expect(screen.getByRole('img', { name: 'image' })).toHaveAttribute(
    'src',
    'https://example.com/image.png'
  )
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy message' })))
  expect(writeClipboardText).toHaveBeenCalledWith(text)
  expect(nativeChatSlotCopyText(slots(message), message.id)).toBe(text)
  const human = { ...message, id: 'human', from: undefined }
  mounted.rerender(
    <NativeChatUserMessageRow
      message={human}
      markdown={text}
      prose={human.blocks}
      rowRef={{ current: null }}
      allowFileUriLinks={false}
      onRefolded={() => {}}
    />
  )
  expect(screen.queryByText('Message from')).not.toBeInTheDocument()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy message' })))
  expect(writeClipboardText).toHaveBeenLastCalledWith(text)
})

it.each(['task', 'mail'] as const)(
  'isolates actual %s body/Markdown work from the avatar, then reparses own blocks and Copy',
  async (kind) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(2_000_000)
    const entry = {
      paneKey: 'sender:11111111-1111-4111-8111-111111111111',
      worktreeId: 'wt-chat',
      terminalHandle: 'term_sender',
      agentType: 'claude',
      state: 'working' as const,
      prompt: '',
      updatedAt: 2_000_000,
      stateStartedAt: 2_000_000,
      stateHistory: [],
      programStatus: { state: 'working' as const, progress: 40, observedAt: 2_000_000 }
    }
    useAppStore.setState({
      tabsByWorktree: { 'wt-chat': [makeTab({ id: 'sender', worktreeId: 'wt-chat' })] },
      agentStatusByPaneKey: { [entry.paneKey]: entry },
      agentStatusEpoch: 1
    })
    const from: AgentMessageSource =
      kind === 'task'
        ? {
            ...source(),
            orchestration: { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
          }
        : source()
    const prefix =
      kind === 'task' ? 'You are working inside Orca, a multi-agent IDE.\n=== TASK ===\n' : ''
    const convert = vi.spyOn(display, 'agentMessageTranscriptText')
    const parse = vi.spyOn(grammar, 'orcaDispatchTaskBodyOffset')
    const paragraphs = vi.spyOn(prose, 'nativeChatProseToMarkdown')
    const renderMarkdown = vi.spyOn(markdown, 'NativeChatMarkdown')
    let mounted = render(card(from, `${prefix}Current **task**`))
    expect(convert).toHaveBeenCalled()
    expect(renderMarkdown).toHaveBeenCalled()
    expect(parse.mock.calls.length).toBe(kind === 'task' ? 1 : 0)
    expect(screen.getByText('task', { selector: 'strong' })).toBeInTheDocument()
    for (const remount of [false, true]) {
      if (remount) {
        mounted.unmount()
        mounted = render(card(from, `${prefix}Current **task**`))
      }
      const ring = screen.getByRole('progressbar', { name: 'Working · 40%' })
      expect(ring).toHaveAttribute('data-agent-progress-ring')
      expect(ring).toHaveAttribute('aria-valuenow', '40')
      expect(ring.querySelector('circle[pathLength="100"]')).toHaveAttribute(
        'stroke-dasharray',
        '40 100'
      )
      expect(screen.queryByLabelText('Working')).not.toBeInTheDocument()
    }
    for (const spy of [convert, parse, paragraphs, renderMarkdown]) {
      spy.mockClear()
    }
    for (const progress of [60, null, 60, 0, 100]) {
      act(() => {
        useAppStore
          .getState()
          .setAgentProgramStatus(
            entry.paneKey,
            progress === null ? null : { state: 'working', progress, observedAt: 2_000_000 }
          )
      })
      if (progress === null) {
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
        expect(screen.getByLabelText('Working')).toBeInTheDocument()
      } else {
        const ring = screen.getByRole('progressbar', { name: `Working · ${progress}%` })
        expect(ring).toHaveAttribute('aria-valuenow', String(progress))
        expect(ring.querySelector('circle[pathLength="100"]')).toHaveAttribute(
          'stroke-dasharray',
          `${progress} 100`
        )
        expect(screen.queryByLabelText('Done')).not.toBeInTheDocument()
      }
      for (const spy of [convert, parse, paragraphs, renderMarkdown]) {
        expect(spy).not.toHaveBeenCalled()
      }
    }
    act(() => {
      const state = useAppStore.getState()
      useAppStore.setState({
        agentStatusByPaneKey: {
          [entry.paneKey]: { ...state.agentStatusByPaneKey[entry.paneKey], state: 'done' }
        },
        agentStatusEpoch: state.agentStatusEpoch + 1
      })
    })
    expect(useAppStore.getState().agentStatusByPaneKey[entry.paneKey].programStatus?.progress).toBe(
      100
    )
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Done')).toBeInTheDocument()
    act(() =>
      useAppStore.setState({
        agentStatusByPaneKey: {
          [entry.paneKey]: { ...entry, state: 'blocked', programStatus: undefined }
        },
        agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1
      })
    )
    expect(screen.getByLabelText('Blocked')).toBeInTheDocument()
    for (const spy of [convert, parse, paragraphs, renderMarkdown]) {
      expect(spy).not.toHaveBeenCalled()
    }
    const writeClipboardText = vi.fn(async () => {})
    vi.stubGlobal('api', { ui: { writeClipboardText } })
    mounted.rerender(card(from, `${prefix}Edited task`))
    expect(screen.getByText('Edited task')).toBeInTheDocument()
    expect(convert).toHaveBeenCalled()
    expect(renderMarkdown).toHaveBeenCalled()
    expect(parse.mock.calls.length).toBe(kind === 'task' ? 1 : 0)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy message' })))
    expect(writeClipboardText).toHaveBeenCalledWith('Edited task')
    vi.useRealTimers()
  }
)
