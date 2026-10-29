import { mkdtemp, writeFile, appendFile, mkdir, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookListenerState, seedLegacyAgentStatusForTests } from '../listener-state'
import { normalizeHookPayload } from '../../agent-hook-listener'
import { ClaudeHelperKillPoller } from './claude-helper-kill-poller'
import { createClaudeTranscriptCursor, readClaudeTranscriptChunk } from './claude-transcript-cursor'
import type { ClaudeLaunchedBackgroundTasks } from '../../claude-owed-task-notifications'
import type { AgentHookEventPayload } from '../listener-event'

let dir: string
const now = Date.parse('2026-10-29T12:00:00Z')
const stamp = (offset: number) => new Date(now + offset).toISOString()
const kill = (offset = 1) =>
  `${JSON.stringify({ type: 'system', subtype: 'agents_killed', timestamp: stamp(offset) })}\n`
const prompt = (offset: number) =>
  `${JSON.stringify({
    type: 'user',
    timestamp: stamp(offset),
    message: { role: 'user', content: 'Do the work' }
  })}\n`

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  dir = await mkdtemp(join(tmpdir(), 'claude-helper-kill-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

async function pane(shell = false, reader = readClaudeTranscriptChunk) {
  const state = createHookListenerState()
  const path = join(dir, 'session.jsonl')
  await writeFile(path, prompt(-20))
  await mkdir(join(dir, 'session', 'subagents'), { recursive: true })
  const child = (id: string) => join(dir, 'session', 'subagents', `agent-${id}.jsonl`)
  await writeFile(child('a123'), prompt(-10))
  let current: AgentHookEventPayload | undefined
  const events: AgentHookEventPayload[] = []
  function post(payload: Record<string, unknown>) {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: 'test-tab:11111111-1111-4111-8111-111111111111',
        env: 'production',
        payload: { session_id: 'session', transcript_path: path, ...payload }
      },
      'production'
    )
    if (!event) {
      throw new Error('hook declined')
    }
    current = event
    seedLegacyAgentStatusForTests(state, event)
    return event
  }
  post({ hook_event_name: 'UserPromptSubmit', prompt: 'work' })
  post({ hook_event_name: 'SubagentStart', agent_id: 'a123' })
  post({
    hook_event_name: 'Stop',
    last_assistant_message: 'READY',
    background_tasks: [
      { id: 'a123', type: 'subagent', status: 'running' },
      ...(shell ? [{ id: 'shell', type: 'local_bash', status: 'running' }] : [])
    ],
    session_crons: []
  })
  const publish = vi.fn((event: AgentHookEventPayload) => {
    current = event
    events.push(event)
    seedLegacyAgentStatusForTests(state, event)
  })
  const poller = new ClaudeHelperKillPoller(
    state,
    { current: () => current, publish, listening: () => true },
    reader
  )
  poller.schedule(current!)
  return {
    state,
    path,
    child,
    post,
    poller,
    publish,
    events,
    row: () => current!,
    replace: (row: AgentHookEventPayload) => {
      current = row
      poller.schedule(row)
    }
  }
}

async function drain(p: Awaited<ReturnType<typeof pane>>) {
  for (let i = 0; i < 8; i++) {
    await p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
  }
}

describe('Claude helper provider evidence', () => {
  it.each([false, true])(
    'retires a killed helper, preserves parent and surviving shell=%s',
    async (shell) => {
      const p = await pane(shell)
      const before = p.row()
      try {
        await appendFile(p.path, kill())
        await drain(p)
        expect(p.row().payload.subagents ?? []).toEqual([])
        expect(p.row().payload.state).toBe(shell ? 'working' : 'done')
        if (shell) {
          expect(p.row().payload.workingMode).toBe('monitoring')
        }
        expect(p.row().payload.mainAgent).toEqual(before.payload.mainAgent)
        expect(p.row().payload.lastAssistantMessage).toBe('READY')
        expect(p.row().hookEventName).toBe('SubagentStop')
        expect(p.row().toolAgentId).toBe('a123')
        expect(p.row().turnEndedAt).toBe(before.turnEndedAt)
      } finally {
        p.poller.clearAll()
      }
    }
  )

  it('does not lose the kill before the first asynchronous open or behind a large prefix', async () => {
    const p = await pane()
    try {
      await appendFile(
        p.path,
        `${kill()}${`${JSON.stringify({ padding: 'x'.repeat(4096) })}\n`.repeat(300)}`
      )
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
    } finally {
      p.poller.clearAll()
    }
  })

  it('retains evidence across same-owner row replacement and a drained-helper gap', async () => {
    const p = await pane()
    try {
      await appendFile(p.path, kill())
      const reading = p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
      p.replace(p.post({ hook_event_name: 'PreToolUse', agent_id: 'a123', tool_name: 'Bash' }))
      await reading
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      vi.mocked(Date.now).mockReturnValue(now + 5)
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      p.replace(
        p.post({
          hook_event_name: 'Stop',
          background_tasks: [{ id: 'a123', type: 'subagent', status: 'running' }]
        })
      )
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      await appendFile(p.child('a123'), prompt(20))
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('working')
    } finally {
      p.poller.clearAll()
    }
  })

  it('uses an explicit provider resume rather than the teammates lifetime display clock', async () => {
    const p = await pane()
    try {
      await appendFile(p.path, kill())
      await drain(p)
      await appendFile(
        p.path,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: stamp(10),
          message: {
            content: [
              { type: 'tool_use', id: 'resume-tool', name: 'Agent', input: { resume: 'a123' } }
            ]
          }
        })}\n`
      )
      await appendFile(
        p.path,
        `${JSON.stringify({
          type: 'user',
          timestamp: stamp(15),
          toolUseResult: { isAsync: true, agentId: 'a123' },
          message: { content: [{ type: 'tool_result', tool_use_id: 'resume-tool' }] }
        })}\n`
      )
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('working')
    } finally {
      p.poller.clearAll()
    }
  })

  it('serializes deferred reads, retains its scheduler entry, and reconciles the latest same-owner hook', async () => {
    vi.useFakeTimers()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const reader: typeof readClaudeTranscriptChunk = async (cursor, limit) => {
      if (first) {
        first = false
        await gate
      }
      return readClaudeTranscriptChunk(cursor, limit)
    }
    const p = await pane(false, reader)
    try {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      const pending = p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
      expect(p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')).toBe(pending)
      await appendFile(p.path, kill())
      p.replace(p.post({ hook_event_name: 'PreToolUse', agent_id: 'a123', tool_name: 'Bash' }))
      release()
      await pending
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      release()
      p.poller.clearAll()
      vi.useRealTimers()
    }
  })

  it('ends only killed agent notification debt and releases its permission wait', async () => {
    const p = await pane()
    try {
      const tasks: ClaudeLaunchedBackgroundTasks = new Map([
        ['a123', { kind: 'agent' as const, notificationOwedAt: now }],
        ['shell', { kind: 'shell' as const, notificationOwedAt: now }]
      ])
      p.state.claudeLaunchedBackgroundTasksByPaneKey.set(
        'test-tab:11111111-1111-4111-8111-111111111111',
        tasks
      )
      p.replace(
        p.post({
          hook_event_name: 'PermissionRequest',
          agent_id: 'a123',
          tool_name: 'Bash',
          tool_use_id: 'approval'
        })
      )
      await appendFile(p.path, kill())
      await drain(p)
      expect(p.row().payload.state).not.toBe('waiting')
      expect(p.row().toolAgentId).toBe('a123')
      expect(tasks.get('a123')).toEqual({
        kind: 'agent',
        notificationOwedAt: undefined,
        settled: true
      })
      expect(tasks.get('shell')?.notificationOwedAt).toBe(now)
    } finally {
      p.poller.clearAll()
    }
  })

  it('ignores old/malformed records, then lets a fresh inventory settle the claim', async () => {
    const p = await pane()
    try {
      await appendFile(
        p.path,
        `${kill(-1)}{"type":"system","subtype":"agents_killed","timestamp":"bad"}\n`
      )
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('working')
      p.replace(p.post({ hook_event_name: 'Stop', background_tasks: [] }))
      expect(p.row().payload.subagents ?? []).toEqual([])
    } finally {
      p.poller.clearAll()
    }
  })

  it('keeps unavailable child generations unverifiable and forgets kills on file replacement', async () => {
    const p = await pane()
    try {
      await rm(p.child('a123'))
      await appendFile(p.path, kill())
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('working')
      await writeFile(p.child('a123'), prompt(-10))
      await drain(p)
      expect(p.row().payload.subagents ?? []).toEqual([])
      await writeFile(join(dir, 'replacement.jsonl'), kill())
      await rename(join(dir, 'replacement.jsonl'), p.path)
      p.replace(p.post({ hook_event_name: 'SubagentStart', agent_id: 'a123' }))
      await drain(p)
      expect(p.row().payload.subagents?.[0]?.state).toBe('working')
    } finally {
      p.poller.clearAll()
    }
  })

  it('does not apply an in-flight read after pane retirement or to its successor', async () => {
    const p = await pane()
    try {
      await appendFile(p.path, kill())
      const reading = p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
      p.poller.clear('test-tab:11111111-1111-4111-8111-111111111111')
      p.replace({
        ...p.row(),
        providerSession: { key: 'session_id', id: 'replacement', transcriptPath: p.path }
      })
      await reading
      expect(p.publish).not.toHaveBeenCalled()
    } finally {
      p.poller.clearAll()
    }
  })
})

describe('forward transcript reading', () => {
  it('carries a record split across chunks without dropping a prefix or UTF-8', async () => {
    const path = join(dir, 'split.jsonl')
    const line = `${JSON.stringify({ type: 'system', subtype: 'agents_killed', timestamp: stamp(1), text: 'é' })}\n`
    await writeFile(path, line)
    const cursor = createClaudeTranscriptCursor(path)
    const records = []
    for (let i = 0; i < 50; i++) {
      const result = await readClaudeTranscriptChunk(cursor, 7)
      records.push(...(result?.records ?? []))
      if (result?.caughtUp) {
        break
      }
    }
    expect(records).toEqual([JSON.parse(line)])
  })

  it('skips one overlong line through its newline and retains the following kill', async () => {
    const path = join(dir, 'oversize.jsonl')
    await writeFile(path, `${'x'.repeat(1024 * 1024 + 10)}\n${kill()}`)
    const cursor = createClaudeTranscriptCursor(path)
    const first = await readClaudeTranscriptChunk(cursor)
    const next = await readClaudeTranscriptChunk(cursor)
    expect(first?.records).toEqual([])
    expect(next?.records).toHaveLength(1)
  })

  it('treats missing files as unverifiable and replacement/shrink as a new baseline', async () => {
    const path = join(dir, 'replace.jsonl')
    const cursor = createClaudeTranscriptCursor(path)
    expect(await readClaudeTranscriptChunk(cursor)).toBeUndefined()
    await writeFile(path, `${prompt(0)}${' '.repeat(200)}`)
    await readClaudeTranscriptChunk(cursor)
    await writeFile(path, kill())
    expect((await readClaudeTranscriptChunk(cursor))?.records).toEqual([])
    await appendFile(path, kill(20))
    expect((await readClaudeTranscriptChunk(cursor))?.records).toHaveLength(1)
  })
})
