import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { makeTab } from '@/store/slices/store-test-helpers'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'
import { NativeChatUserMessageRow } from './NativeChatUserMessageRow'

const workspace = 'agent-message-fixture'
const pane = 'sender:11111111-1111-4111-8111-111111111111'
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAAA8CAIAAADXHaAKAAAAvklEQVR4nO3SUQkAIBTAwBfUAAawP5YQhHFwAfaxWftAxnwvgIcMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSbm/mJH95bvMnAAAAABJRU5ErkJggg=='
const prose =
  'First paragraph with **real Markdown**, a [web link](https://example.com) and inline `code`.\n\nSecond paragraph keeps its own spacing. This longer line wraps differently in the narrow frame, so Show more is based on rendered lines.\n\n![Example image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAAA8CAIAAADXHaAKAAAAvklEQVR4nO3SUQkAIBTAwBfUAAawP5YQhHFwAfaxWftAxnwvgIcMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSbm/mJH95bvMnAAAAABJRU5ErkJggg==)\n\nLast paragraph after the image.'
function cards() {
  const human: NativeChatMessage = {
    id: 'human',
    role: 'user',
    source: 'transcript',
    blocks: [{ type: 'text', text: 'An ordinary human message.' }],
    timestamp: 1_800_000_000_000
  }
  return (
    <div className="space-y-4 p-4">
      {(['task', 'coordinator', 'worker', 'generic'] as const).map((kind, i) => {
        const from: AgentMessageSource = {
          kind: 'agent',
          senders: (kind === 'generic'
            ? ['A sender on another host with a long name', null, 'Parser worker', 'Fourth sender']
            : ['Parser worker']
          ).map((name, index) => ({
            party: {
              address:
                kind === 'generic' && index === 0
                  ? 'dispatch:missing'
                  : kind === 'task'
                    ? 'term_progress'
                    : `term_sender${index || ''}`,
              terminalHandle:
                kind === 'generic' && index === 0
                  ? null
                  : kind === 'task'
                    ? 'term_progress'
                    : `term_sender${index || ''}`,
              orcaSessionId: null
            },
            name,
            ...(kind === 'worker' || kind === 'coordinator' ? { relation: kind } : {})
          })),
          orchestration:
            kind === 'task'
              ? { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
              : {
                  message: 'mail-notice',
                  mailbox: 'term_recipient',
                  dispatchId: null,
                  messages: []
                }
        }
        return (
          <NativeChatAgentMessageCard
            key={kind}
            message={{
              id: kind,
              role: 'user',
              source: 'transcript',
              blocks: [
                { type: 'text', text: i === 0 ? 'A short task fits without a disclosure.' : prose },
                ...(kind === 'generic'
                  ? [{ type: 'image-ref' as const, url: image, alt: 'Attached diagram' }]
                  : [])
              ],
              timestamp: 1_800_000_000_000,
              from
            }}
            from={from}
            runtimeContext={{
              worktreeId: workspace,
              worktreePath: null,
              target: { kind: 'local' }
            }}
            allowFileUriLinks={false}
            onRefolded={() => {}}
          />
        )
      })}
      <NativeChatUserMessageRow
        message={human}
        markdown="An ordinary human message."
        prose={human.blocks}
        rowRef={{ current: null }}
        allowFileUriLinks={false}
        onRefolded={() => {}}
      />
    </div>
  )
}
const store = {
  activeWorktreeId: workspace,
  activeWorkspaceExecutionHostId: 'local' as const,
  tabsByWorktree: {
    [workspace]: ['sender', 'progress'].map((id) => makeTab({ id, worktreeId: workspace }))
  },
  agentStatusByPaneKey: {
    [pane]: {
      paneKey: pane,
      worktreeId: workspace,
      terminalHandle: 'term_sender',
      agentType: 'codex' as const,
      state: 'done' as const,
      prompt: 'Parser worker',
      updatedAt: 1_800_000_000_000,
      stateStartedAt: 1_800_000_000_000,
      stateHistory: []
    },
    'progress:11111111-1111-4111-8111-111111111111': {
      paneKey: 'progress:11111111-1111-4111-8111-111111111111',
      worktreeId: workspace,
      terminalHandle: 'term_progress',
      agentType: 'claude' as const,
      state: 'working' as const,
      prompt: 'Parser worker',
      updatedAt: 1_800_000_000_000,
      stateStartedAt: 1_800_000_000_000,
      stateHistory: [],
      programStatus: { state: 'working' as const, progress: 40, observedAt: 1_800_000_000_000 }
    }
  }
}
export const wide = defineFixture({ width: 720, store, render: cards })
export const narrow = defineFixture({ width: 340, store, render: cards })
export const expanded = defineFixture({
  width: 720,
  store,
  render: cards,
  interact: (frame) => {
    for (const button of frame.querySelectorAll('button')) {
      if (button.textContent === 'Show more') {
        button.click()
      }
    }
  }
})
