import { afterEach, expect, it, vi } from 'vitest'
import { checkpointJournalRig, closeCheckpointTestJournals } from './claude-checkpoint-test-support'
afterEach(closeCheckpointTestJournals)

it('bounds the typed authentication collision with actual translator and journal', async () => {
  const r = await checkpointJournalRig()
  vi.useFakeTimers()
  r.stream({ type: 'message_start', message: { id: 'reply', role: 'assistant', content: [] } })
  r.stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'accepted prefix' }
  })
  vi.advanceTimersByTime(60)
  await r.deferred.drained()
  r.message({
    type: 'assistant',
    error: 'authentication_failed',
    user_message_uuid: 'send',
    message: {
      id: 'reply',
      role: 'assistant',
      content: [{ type: 'text', text: 'provider diagnostic' }]
    }
  })
  await r.deferred.drained()
  expect(r.journal.itemBody('claude:claude-session:block%3Areply%3A0')).toMatchObject({
    blocks: [{ type: 'text', text: 'accepted prefix' }]
  })
  r.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' tail' } })
  vi.advanceTimersByTime(60)
  r.message({
    type: 'result',
    is_error: true,
    user_message_uuid: 'send',
    errors: ['provider diagnostic']
  })
  await r.deferred.drained()
  expect(r.journal.itemBody('claude:claude-session:block%3Areply%3A0')).toMatchObject({
    blocks: [{ type: 'text', text: 'accepted prefix tail' }]
  })
  expect(
    r.journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
  ).toHaveLength(1)
  r.translator.dispose()
})

it.each(['idle', 'next-send', 'ended'] as const)(
  'recovers accepted prefix across %s and preserves first envelope on reopen',
  async (boundary) => {
    const r = await checkpointJournalRig()
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    r.message({
      type: 'user',
      uuid: 'user-1',
      message: { role: 'user', content: [{ type: 'text', text: 'question' }] }
    })
    r.stream({ type: 'message_start', message: { id: 'reply', role: 'assistant', content: [] } })
    for (const [index, type, field] of [
      [0, 'text_delta', 'text'],
      [1, 'thinking_delta', 'thinking']
    ] as const) {
      r.stream({ type: 'content_block_delta', index, delta: { type, [field]: 'prefix' } })
    }
    vi.advanceTimersByTime(60)
    await r.deferred.drained()
    const before = r.journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'message' && item.body.role !== 'user')
    if (boundary === 'ended') {
      r.translator.handle({
        type: 'ended',
        sessionId: 'recovery',
        observedAt: 1100,
        reason: 'exit'
      })
    } else {
      r.message({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    }
    if (boundary === 'next-send') {
      r.translator.handle({
        type: 'message',
        sessionId: 'recovery',
        startsTurn: true,
        message: {
          type: 'user',
          uuid: 'user-2',
          session_id: 'claude-session',
          message: { role: 'user', content: [{ type: 'text', text: 'next question' }] }
        }
      })
    }
    for (const [index, type, field] of [
      [0, 'text_delta', 'text'],
      [1, 'thinking_delta', 'thinking']
    ] as const) {
      r.stream({ type: 'content_block_delta', index, delta: { type, [field]: ' tail' } })
    }
    vi.advanceTimersByTime(400)
    await r.deferred.drained()
    for (const first of before) {
      const current = r.journal.item(first.itemId)
      expect(current?.body).toMatchObject({ blocks: [{ type: 'text', text: 'prefix tail' }] })
      expect(current).toMatchObject({
        sequence: first.sequence,
        observedAt: first.observedAt,
        turnScope: first.turnScope
      })
      if (current?.body.kind === 'message' && current.body.role === 'reasoning') {
        expect(current.body).toMatchObject({
          state: 'completed',
          completedAt: boundary === 'ended' ? 1100 : 1060
        })
      }
    }
    expect(r.translator.pendingStreamedBlocks).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    r.translator.dispose()
    const saved = r.journal.snapshot().items
    await r.journal.close()
    const reopened = await r.reopen()
    expect(reopened.snapshot().items).toEqual(saved)
  }
)

it.each([false, true])(
  'completes 257 published reasoning blocks, textless final=%s, and reenters an evicted key',
  async (textless) => {
    const r = await checkpointJournalRig()
    vi.useFakeTimers()
    r.stream({ type: 'message_start', message: { id: 'many', role: 'assistant', content: [] } })
    for (let index = 0; index < 257; index++) {
      if (index % 2) {
        r.stream({
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '' }
        })
      }
      r.stream({
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: `thought-${index}` }
      })
    }
    vi.advanceTimersByTime(60)
    await r.deferred.drained()
    if (textless) {
      r.message({
        type: 'assistant',
        message: { id: 'many', role: 'assistant', content: [{ type: 'thinking', thinking: '' }] }
      })
    }
    r.message({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await r.deferred.drained()
    const rows = r.journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'message' && item.body.role === 'reasoning')
    expect(rows).toHaveLength(257)
    for (const [index, row] of rows.entries()) {
      expect(row.body).toMatchObject({
        state: 'completed',
        blocks: [{ type: 'text', text: `thought-${index}` }]
      })
    }
    r.stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: ' tail' }
    })
    vi.advanceTimersByTime(400)
    await r.deferred.drained()
    expect(r.journal.item(rows[0].itemId)?.body).toMatchObject({
      state: 'completed',
      blocks: [{ type: 'text', text: 'thought-0 tail' }]
    })
    expect(r.translator.pendingStreamedBlocks).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    r.translator.dispose()
  }
)

it.each(['text', 'thinking'] as const)(
  'orders full %s final, later suffix and same-ID reentry without losing blocks',
  async (channel) => {
    const r = await checkpointJournalRig()
    vi.useFakeTimers()
    r.stream({ type: 'message_start', message: { id: 'reply', role: 'assistant', content: [] } })
    const delta = (text: string) =>
      r.stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: `${channel}_delta`, [channel]: text }
      })
    delta('prefix')
    vi.advanceTimersByTime(60)
    r.message({
      type: 'assistant',
      message: { id: 'reply', role: 'assistant', content: [{ type: channel, [channel]: 'FULL' }] }
    })
    delta(' tail')
    vi.advanceTimersByTime(400)
    await r.deferred.drained()
    const key = 'claude:claude-session:block%3Areply%3A0'
    const first = r.journal.item(key)
    expect(first?.body).toMatchObject({ blocks: [{ type: 'text', text: 'FULL tail' }] })
    r.stream({ type: 'message_start', message: { id: 'reply', role: 'assistant', content: [] } })
    delta(' reentry')
    vi.advanceTimersByTime(60)
    await r.deferred.drained()
    expect(r.journal.item(key)?.body).toMatchObject({
      blocks: [{ type: 'text', text: 'FULL tail reentry' }]
    })
    expect(r.journal.item(key)).toMatchObject({
      sequence: first?.sequence,
      observedAt: first?.observedAt
    })
    r.translator.dispose()
  }
)

it('retains refused original-turn output through a real blocked queue and next-send dispatch settlement, then drains without another frame', async () => {
  const r = await checkpointJournalRig({
    watermarks: {
      maxQueuedOperations: 1,
      maxLifecycleQueuedOperations: 1,
      lowQueuedOperations: 0,
      lowQueuedBytes: 0
    }
  })
  const { sessionFor, userMessage } = await import('./claude-structured-dispatch-test-support')
  const { dispatchClaudeTurn } = await import('./claude-structured-dispatch')
  const { resolveClaudeReplayTurn } = await import('./claude-replay-turn-resolution')
  const { bindClaudeJournalReadingControl } =
    await import('./claude-structured-session-journal-control')
  vi.useFakeTimers()
  vi.setSystemTime(0)
  r.stream({ type: 'message_start', message: { id: 'reply', role: 'assistant', content: [] } })
  const origin = r.translator.currentTurnScope()
  await r.deferred.drained()
  const gate = Promise.withResolvers<void>()
  await r.journal.readInOrder(() => {
    void r.journal.readInOrder(() => gate.promise)
  })
  const id = (uuid: string) => ({ provider: 'claude' as const, sessionId: 'claude-session', uuid })
  r.deferred.sink.tryAppendItem?.(
    id('block-ordinary'),
    { kind: 'status', tone: 'info', text: 'ordinary' },
    { turnScope: { kind: 'thread' } }
  )
  r.deferred.sink.tryAppendItem?.(
    id('block-lifecycle'),
    { kind: 'status', tone: 'info', text: 'lifecycle' },
    { turnScope: { kind: 'thread' }, lifecycle: true }
  )
  const resume = vi.fn()
  const unbind = bindClaudeJournalReadingControl(
    r.deferred.sink,
    { pauseReading: vi.fn(), resumeReading: resume },
    r.translator
  )
  for (const [index, type, field] of [
    [0, 'text_delta', 'text'],
    [1, 'thinking_delta', 'thinking']
  ] as const) {
    r.stream({ type: 'content_block_delta', index, delta: { type, [field]: 'original answer' } })
  }
  vi.advanceTimersByTime(60)
  r.message({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  expect(r.translator.pendingStreamedBlocks).toBe(2)
  const session = sessionFor()
  session.translator = r.translator
  session.events = r.deferred.sink
  session.providerSessionId = 'claude-session'
  const next = dispatchClaudeTurn(session, {
    clientMessageId: 'send-2',
    body: userMessage([{ type: 'text', text: 'next question' }])
  })
  await vi.advanceTimersByTimeAsync(0)
  await expect(next).resolves.toEqual({ state: 'admitted' })
  const uuid = session.dispatchWaiters[0]?.sentUuid
  expect(uuid).toBeTruthy()
  const echo = {
    type: 'user',
    uuid,
    session_id: 'claude-session',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'next question' }] }
  }
  expect(resolveClaudeReplayTurn(session, echo)).not.toBeNull()
  expect(session.dispatchWaiters).toHaveLength(0)
  r.translator.handle({ type: 'message', sessionId: 'recovery', startsTurn: true, message: echo })
  gate.resolve()
  await r.deferred.drained()
  await Promise.resolve()
  await r.deferred.drained()
  const answers = r.journal
    .snapshot()
    .items.filter((item) => item.body.kind === 'message' && item.body.role !== 'user')
  expect(answers).toHaveLength(2)
  for (const answer of answers) {
    expect(answer.turnScope).toEqual(origin)
    expect(answer.body).toMatchObject({ blocks: [{ type: 'text', text: 'original answer' }] })
  }
  expect(
    answers.find((item) => item.body.kind === 'message' && item.body.role === 'reasoning')?.body
  ).toMatchObject({ state: 'completed', completedAt: 60 })
  expect(r.translator.pendingStreamedBlocks).toBe(0)
  expect(resume).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  unbind?.()
  r.translator.dispose()
})

it('sizes an expanded escaped uncommitted replacement before compose, orders its suffix before a tool, and releases allocation', async () => {
  const r = await checkpointJournalRig()
  const { StructuredAgentSessionSinkQueue } =
    await import('../native-chat/agent-session-wire/structured-agent-session-event-sink-queue')
  const allocate = StructuredAgentSessionSinkQueue.prototype.allocate
  const allocations: number[] = []
  let outstanding = 0
  const spy = vi
    .spyOn(StructuredAgentSessionSinkQueue.prototype, 'allocate')
    .mockImplementation(function (
      this: InstanceType<typeof StructuredAgentSessionSinkQueue>,
      bytes,
      lifecycle
    ) {
      allocations.push(bytes)
      outstanding += bytes
      const release = allocate.call(this, bytes, lifecycle)
      return () => {
        release()
        outstanding -= bytes
      }
    })
  vi.useFakeTimers()
  const gate = Promise.withResolvers<void>()
  await r.journal.readInOrder(() => {
    void r.journal.readInOrder(() => gate.promise)
  })
  r.stream({ type: 'message_start', message: { id: 'reply', role: 'assistant', content: [] } })
  r.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'P' } })
  vi.advanceTimersByTime(60)
  const full = `${'"\\\n\u0000🦊'.repeat(4096)}\ud83d`
  r.message({
    type: 'assistant',
    message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text: full }] }
  })
  r.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\ude80' } })
  r.message({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }]
    }
  })
  expect(r.journal.itemBody('claude:claude-session:block%3Areply%3A0')).toBeNull()
  gate.resolve()
  await r.deferred.drained()
  const item = r.journal
    .snapshot()
    .items.find((item) => item.itemId === 'claude:claude-session:block%3Areply%3A0')
  expect(item?.body).toMatchObject({ blocks: [{ type: 'text', text: `${full}\ude80` }] })
  const identity = { provider: 'claude', sessionId: 'claude-session', uuid: 'block:reply:0' }
  expect(allocations).toContain(
    Buffer.byteLength(JSON.stringify({ identity, body: item?.body }), 'utf8') + 512
  )
  const tool = r.journal.snapshot().items.find((item) => item.body.kind === 'tool-call')
  expect(tool?.sequence).toBeGreaterThan(item?.sequence ?? 0)
  expect(outstanding).toBe(0)
  expect(r.deferred.state().queuedBytes).toBe(0)
  spy.mockRestore()
  r.translator.dispose()
})

it.each(['bind', 'close', 'publication-failure'] as const)(
  'settles transferred work exactly once on %s',
  async (outcome) => {
    const r = await checkpointJournalRig({ unbound: outcome !== 'publication-failure' })
    vi.useFakeTimers()
    if (outcome === 'publication-failure') {
      r.publish.mockImplementation(() => {
        throw new Error('publish failed')
      })
    }
    r.stream({ type: 'message_start', message: { id: 'reply', role: 'assistant', content: [] } })
    r.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'once' } })
    vi.advanceTimersByTime(60)
    expect(r.translator.pendingStreamedBlocks).toBe(0)
    r.translator.flush()
    if (outcome === 'bind') {
      r.bind()
    }
    if (outcome === 'close') {
      r.deferred.close()
    }
    await expect(r.deferred.sink.written?.()).resolves.toMatchObject({ ok: outcome === 'bind' })
    const body = r.journal.itemBody('claude:claude-session:block%3Areply%3A0')
    if (outcome === 'close') {
      expect(body).toBeNull()
    } else {
      expect(body).toMatchObject({ blocks: [{ type: 'text', text: 'once' }] })
    }
    expect(r.deferred.state().queuedBytes).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    r.translator.dispose()
  }
)

it.each([false, true])(
  'preserves compatible blocks, hints and terminal facts through keyed canonical resolution (alias=%s)',
  async (aliased) => {
    const r = await checkpointJournalRig()
    const identity = {
      provider: 'claude' as const,
      sessionId: 'claude-session',
      uuid: aliased ? 'canonical-reasoning' : 'block:reply:0'
    }
    const body = {
      kind: 'message' as const,
      role: 'reasoning' as const,
      state: 'completed' as const,
      completedAt: 99,
      blocks: [
        { type: 'text' as const, text: 'head', presentation: 'markdown' },
        { type: 'image-ref' as const, path: '/workspace/image.png' },
        { type: 'text' as const, text: 'tail', tone: 'info' }
      ]
    }
    await r.journal.appendItem(identity, body, {
      fence: 1,
      turnScope: { kind: 'thread' },
      observedAt: 11
    })
    const sourceKey = 'claude:claude-session:block%3Areply%3A0'
    const canonicalKey = aliased ? 'claude:claude-session:canonical-reasoning' : sourceKey
    const resolve = r.journal.canonicalItemId.bind(r.journal)
    // Inject only the alias answer; the selected body, ordered write, fold and reopen stay real.
    const alias = vi
      .spyOn(r.journal, 'canonicalItemId')
      .mockImplementation((key) => (key === sourceKey ? canonicalKey : resolve(key)))
    vi.useFakeTimers()
    r.stream({ type: 'message_start', message: { id: 'reply', role: 'assistant', content: [] } })
    r.stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: ' suffix' }
    })
    vi.advanceTimersByTime(60)
    await r.deferred.drained()
    expect(r.journal.item(canonicalKey)).toMatchObject({
      observedAt: 11,
      turnScope: { kind: 'thread' },
      body: {
        ...body,
        blocks: [...body.blocks.slice(0, -1), { type: 'text', text: 'tail suffix', tone: 'info' }]
      }
    })
    if (aliased) {
      expect(r.journal.item(sourceKey)).toBeNull()
    }
    alias.mockRestore()
    r.translator.dispose()
  }
)

it('keeps timed selected work independent of H history and clean A routes, with linear batched end work', async () => {
  const traces: { timer: number; end: number; keyed: number; cleanWrites: number }[] = []
  for (const scale of [1, 10]) {
    const r = await checkpointJournalRig()
    for (let i = 0; i < 100 * scale; i++) {
      await r.journal.appendItem(
        { provider: 'claude', sessionId: 'claude-session', uuid: `history-${i}` },
        { kind: 'status', tone: 'info', text: 'unrelated' },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
    }
    vi.useFakeTimers()
    r.stream({ type: 'message_start', message: { id: 'active', role: 'assistant', content: [] } })
    for (let i = 0; i < 20 * scale; i++) {
      r.stream({
        type: 'content_block_delta',
        index: i,
        delta: { type: 'thinking_delta', thinking: 'P' }
      })
    }
    vi.advanceTimersByTime(60)
    await r.deferred.drained()
    const item = vi.spyOn(r.journal, 'item')
    const history = vi.spyOn(r.journal, 'visitItems')
    let visits = 0
    const iterate = Map.prototype[Symbol.iterator]
    const values = Map.prototype.values
    const count = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      const iterator = iterate.call(this)
      const next = iterator.next.bind(iterator)
      iterator.next = () => {
        const value = next()
        if (!value.done) {
          visits++
        }
        return value
      }
      return iterator
    })
    const countValues = vi.spyOn(Map.prototype, 'values').mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      const iterator = values.call(this)
      const next = iterator.next.bind(iterator)
      iterator.next = () => {
        const value = next()
        if (!value.done) {
          visits++
        }
        return value
      }
      return iterator
    })
    r.stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'T' }
    })
    vi.advanceTimersByTime(400)
    await r.deferred.drained()
    const timer = visits
    const keyed = item.mock.calls.length
    expect(history).not.toHaveBeenCalled()
    visits = 0
    r.message({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await r.deferred.drained()
    const end = visits
    const revision = r.journal.cursor().sequence
    r.message({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await r.deferred.drained()
    traces.push({ timer, end, keyed, cleanWrites: r.journal.cursor().sequence - revision })
    count.mockRestore()
    countValues.mockRestore()
    item.mockRestore()
    history.mockRestore()
    expect(r.translator.pendingStreamedBlocks).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    r.translator.dispose()
    vi.useRealTimers()
  }
  expect(traces[1].keyed).toBe(traces[0].keyed)
  expect(traces[1].timer).toBeLessThanOrEqual(traces[0].timer + 2)
  expect(traces[1].end).toBeLessThanOrEqual(traces[0].end * 11)
  expect(traces.map((trace) => trace.cleanWrites)).toEqual([0, 0])
})

it('frees clean 256×128KiB delivery bytes, accepts a new key and extends the oldest without shortening it', async () => {
  const r = await checkpointJournalRig()
  vi.useFakeTimers()
  const chunk = 'x'.repeat(128 * 1024)
  r.stream({ type: 'message_start', message: { id: 'pressure', role: 'assistant', content: [] } })
  for (let index = 0; index < 256; index++) {
    r.stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } })
  }
  vi.advanceTimersByTime(60)
  await r.deferred.drained()
  expect(r.translator.pendingStreamedBlocks).toBe(0)
  r.stream({ type: 'content_block_delta', index: 256, delta: { type: 'text_delta', text: chunk } })
  r.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tail' } })
  vi.advanceTimersByTime(400)
  await r.deferred.drained()
  expect(r.journal.itemBody('claude:claude-session:block%3Apressure%3A0')).toMatchObject({
    blocks: [{ type: 'text', text: `${chunk}tail` }]
  })
  expect(r.journal.itemBody('claude:claude-session:block%3Apressure%3A256')).toMatchObject({
    blocks: [{ type: 'text', text: chunk }]
  })
  expect(r.translator.pendingStreamedBlocks).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  r.translator.dispose()
})

it.each(['count', 'bytes'] as const)(
  'owns the incoming frame and partial offset under refused %s pressure until actual drain',
  async (pressure) => {
    const r = await checkpointJournalRig({
      watermarks: { maxQueuedOperations: 1, lowQueuedOperations: 0, lowQueuedBytes: 0 }
    })
    const { bindClaudeJournalReadingControl } =
      await import('./claude-structured-session-journal-control')
    vi.useFakeTimers()
    r.stream({ type: 'message_start', message: { id: 'pressure', role: 'assistant', content: [] } })
    await r.deferred.drained()
    const gate = Promise.withResolvers<void>()
    await r.journal.readInOrder(() => {
      void r.journal.readInOrder(() => gate.promise)
    })
    r.deferred.sink.tryAppendItem?.(
      { provider: 'claude', sessionId: 'claude-session', uuid: 'blocker' },
      { kind: 'status', tone: 'info', text: 'blocked' },
      { turnScope: { kind: 'thread' } }
    )
    const unbind = bindClaudeJournalReadingControl(
      r.deferred.sink,
      { pauseReading: vi.fn(), resumeReading: vi.fn() },
      r.translator
    )
    const n = pressure === 'count' ? 256 : 2
    const prefix = pressure === 'count' ? 'prefix' : 'x'.repeat(16 * 1024 * 1024 - 2)
    for (let index = 0; index < n; index++) {
      r.stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: prefix } })
    }
    const incoming = 'ABCD🦊suffix'
    r.stream({
      type: 'content_block_delta',
      index: n,
      delta: { type: 'text_delta', text: incoming }
    })
    let delivered = false
    void r.translator.whenDelivered?.().then(() => {
      delivered = true
    })
    await Promise.resolve()
    expect(delivered).toBe(false)
    gate.resolve()
    await r.deferred.drained()
    await r.translator.whenDelivered?.()
    vi.advanceTimersByTime(60)
    await r.deferred.drained()
    expect(r.journal.itemBody(`claude:claude-session:block%3Apressure%3A${n}`)).toMatchObject({
      blocks: [{ type: 'text', text: incoming }]
    })
    expect(r.journal.itemBody('claude:claude-session:block%3Apressure%3A0')).toMatchObject({
      blocks: [{ type: 'text', text: prefix }]
    })
    expect(r.translator.pendingStreamedBlocks).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    unbind?.()
    r.translator.dispose()
  }
)

it('keeps the incarnation byte limit across checkpoints, preserves accepted prefix plus marker, and accepts a tail on a larger full final', async () => {
  const r = await checkpointJournalRig()
  const {
    AGENT_SESSION_STREAMED_TEXT_MAX_BYTES: limit,
    AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER: marker
  } = await import('../native-chat/agent-session-wire/agent-session-text-prefix')
  vi.useFakeTimers()
  r.stream({ type: 'message_start', message: { id: 'large', role: 'assistant', content: [] } })
  const delta = (text: string) =>
    r.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  const prefix = 'x'.repeat(limit)
  delta(prefix)
  vi.advanceTimersByTime(60)
  await r.deferred.drained()
  delta('over limit')
  vi.advanceTimersByTime(400)
  await r.deferred.drained()
  const key = 'claude:claude-session:block%3Alarge%3A0'
  expect(r.journal.itemBody(key)).toMatchObject({
    blocks: [{ type: 'text', text: `${prefix}${marker}` }]
  })
  delta('also over limit')
  vi.advanceTimersByTime(400)
  await r.deferred.drained()
  expect(r.translator.pendingStreamedBlocks).toBe(0)
  const full = `${prefix}authoritative extra`
  r.message({
    type: 'assistant',
    message: { id: 'large', role: 'assistant', content: [{ type: 'text', text: full }] }
  })
  delta(' late')
  vi.advanceTimersByTime(400)
  await r.deferred.drained()
  expect(r.journal.itemBody(key)).toMatchObject({
    blocks: [{ type: 'text', text: `${full} late` }]
  })
  expect(vi.getTimerCount()).toBe(0)
  r.translator.dispose()
})

it('retires prior message metadata and hands more than 512 owners off with bounded final-tail admissions', async () => {
  const r = await checkpointJournalRig()
  vi.useFakeTimers()
  const routes = new Set<Map<unknown, unknown>>()
  const set = Map.prototype.set
  const track = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value
  ) {
    if (value && typeof value === 'object' && 'identity' in value && 'truncated' in value) {
      routes.add(this)
    }
    return set.call(this, key, value)
  })
  for (let message = 0; message < 30; message++) {
    r.stream({ type: 'message_start', message: { id: `message-${message}` } })
    r.stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'P' }
    })
    r.translator.flush()
    await r.deferred.drained()
    expect([...routes].reduce((n, map) => n + map.size, 0)).toBe(1)
  }
  for (let index = 1; index < 600; index++) {
    r.stream({
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking: 'P' }
    })
  }
  const transitions = vi.spyOn(r.deferred.sink, 'tryAppendTransition')
  await r.translator.retireOutput?.(Promise.resolve())
  expect(
    transitions.mock.calls.filter(([transition]) => transition.finalTail).length
  ).toBeLessThanOrEqual(2)
  expect(
    r.journal
      .snapshot()
      .items.filter(
        (item) =>
          item.body.kind === 'message' &&
          item.body.role === 'reasoning' &&
          item.body.state === 'completed'
      )
  ).toHaveLength(629)
  expect([...routes].every((map) => map.size === 0)).toBe(true)
  expect(r.translator.pendingStreamedBlocks).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  track.mockRestore()
})

it('terminates an old admitted checkpoint through the existing fence failure after epoch replacement', async () => {
  const r = await checkpointJournalRig()
  vi.useFakeTimers()
  r.stream({ type: 'message_start', message: { id: 'old' } })
  r.stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'old text' }
  })
  await r.journal.replaceEpochItems('handle_forked', 2, [])
  vi.advanceTimersByTime(60)
  await expect(r.deferred.sink.written?.()).resolves.toMatchObject({ ok: false })
  expect(r.journal.itemBody('claude:claude-session:block%3Aold%3A0')).toBeNull()
  await expect(r.translator.retireOutput?.(Promise.resolve())).rejects.toThrow()
  expect(r.deferred.state().queuedBytes).toBe(0)
  expect(r.translator.pendingStreamedBlocks).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
