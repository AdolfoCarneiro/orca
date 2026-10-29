import { describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../native-chat-types'
import { nativeChatAskDismissKey } from '../../native-chat-ask-dismiss-key'
import {
  extractPendingAsk,
  extractPendingMessageReplyAsk,
  resolveNativeChatAsk
} from './native-chat-ask'

function message(id: string, blocks: NativeChatBlock[]): NativeChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 1, source: 'transcript' }
}

function call(name: string, input: unknown): NativeChatBlock {
  return { type: 'tool-call', name, input }
}

function result(): NativeChatBlock {
  return { type: 'tool-result', output: 'ok' }
}

/** The row the transcript decoders emit for an interrupted turn. */
function interrupted(id: string): NativeChatMessage {
  return {
    id,
    role: 'system',
    blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
    timestamp: 1,
    source: 'transcript'
  }
}

function userTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp: 1, source: 'transcript' }
}

/** Claude delivers tool results on their own turn, which decodes as role 'tool'. */
function toolTurn(id: string): NativeChatMessage {
  return { id, role: 'tool', blocks: [result()], timestamp: 1, source: 'transcript' }
}

const QUESTIONS_INPUT = {
  questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }]
}

describe('extractPendingAsk', () => {
  it('recognizes an unregistered tool whose input matches the canonical questions shape', () => {
    // Match live status’s arbitrary-tool canonical-shape fallback during transcript replay.
    const pending = extractPendingAsk([message('m1', [call('CustomAskTool', QUESTIONS_INPUT)])])
    expect(pending?.questions[0]?.question).toBe('Deploy?')
  })

  it('resolves calls FIFO so a sibling result cannot clear a newer pending ask', () => {
    const pending = extractPendingAsk([
      message('m1', [
        call('Bash', { command: 'ls' }),
        call('AskUserQuestion', QUESTIONS_INPUT),
        // FIFO: this result answers the Bash call, not the ask.
        result()
      ])
    ])
    expect(pending?.questions[0]?.question).toBe('Deploy?')
  })

  it('keeps the newest ask when an older call receives its result', () => {
    const first = { questions: [{ question: 'First?', options: [] }] }
    const pending = extractPendingAsk([
      message('m1', [
        call('AskUserQuestion', first),
        call('AskUserQuestion', QUESTIONS_INPUT),
        // Resolves the FIRST ask (FIFO); the newer one stays pending.
        result()
      ])
    ])
    expect(pending?.questions[0]?.question).toBe('Deploy?')
  })

  it('does not strand an answered ask behind a tool call orphaned by an interrupt', () => {
    // Claude interrupts omit tool results, leaving orphan FIFO slots (#11761).
    const pending = extractPendingAsk([
      message('m1', [call('Bash', { command: 'sleep 999' })]),
      interrupted('m2'),
      message('m3', [call('AskUserQuestion', QUESTIONS_INPUT)]),
      message('m4', [result()])
    ])
    expect(pending).toBeNull()
  })

  it('drops an ask abandoned by an interrupt', () => {
    const pending = extractPendingAsk([
      message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
      interrupted('m2')
    ])
    expect(pending).toBeNull()
  })

  it('drops an ask the user typed past instead of answering', () => {
    // Escaping a selector and sending a prompt can leave the ask without a result.
    const pending = extractPendingAsk([
      message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
      userTurn('m2', 'never mind, do this instead'),
      message('m3', [{ type: 'text', text: 'on it' }])
    ])
    expect(pending).toBeNull()
  })

  it('does not strand an answered ask behind an orphan left by a plain-text interrupt', () => {
    // Claude can record interrupts as bare user turns without interruptedMessageId/status rows.
    const pending = extractPendingAsk([
      message('m1', [call('Bash', { command: 'sleep 999' })]),
      userTurn('m2', '[Request interrupted by user]'),
      message('m3', [call('AskUserQuestion', QUESTIONS_INPUT)]),
      toolTurn('m4')
    ])
    expect(pending).toBeNull()
  })
})

describe('resolveNativeChatAsk', () => {
  const transcript = [message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)])]

  it('withholds transcript state until the read settles', () => {
    expect(
      resolveNativeChatAsk({ liveAsk: null, messages: transcript, transcriptSettled: false })
    ).toBeNull()
    expect(
      resolveNativeChatAsk({ liveAsk: null, messages: transcript, transcriptSettled: true })
    )?.toMatchObject(QUESTIONS_INPUT)
  })
})

describe('async questions', () => {
  const asyncCall = (callId: string, title: string): NativeChatBlock => ({
    type: 'tool-call',
    name: 'request_user_input_async',
    callId,
    input: JSON.stringify({ questions: [{ title }] })
  })
  const userRow = (id: string, flags: Partial<NativeChatMessage> = {}): NativeChatMessage => ({
    ...message(id, [{ type: 'text', text: 'hi' }]),
    role: 'user',
    ...flags
  })
  it('keeps every unanswered async question, once per call', () => {
    const first = message('a', [
      call('request_user_input_async', { questions: [{ title: 'A?' }, { title: 'B?' }] }),
      asyncCall('call-c', 'C?'),
      result()
    ])
    const pending = extractPendingAsk([first, message('b', [asyncCall('call-c', 'C?')])])
    expect(pending?.questions.map((question) => question.question)).toEqual(['A?', 'B?', 'C?'])
    expect(pending?.occurrenceKey).toBe(JSON.stringify(['a', 'a']))
    const key = nativeChatAskDismissKey(pending)
    expect(nativeChatAskDismissKey(extractPendingAsk([first, toolTurn('ack')]))).toBe(key)
    const expanded = extractPendingAsk([first, message('b', [asyncCall('call-d', 'C?')])])
    expect(expanded?.occurrenceKey).toBe(JSON.stringify(['a', 'a', 'b']))
    expect(nativeChatAskDismissKey(expanded)).not.toBe(key)
  })

  it('stays open until a user message reaches the agent', () => {
    const asked = message('a', [asyncCall('call-a', 'A?'), result()])
    for (const flags of [
      { queued: true },
      { unsent: true },
      { stoppedBeforeStart: true },
      { awaitsRetry: true },
      { sentWhileStopping: true }
    ] as const) {
      expect(extractPendingAsk([asked, userRow('pending', flags)])).toEqual(
        extractPendingAsk([asked])
      )
    }
    expect(extractPendingAsk([asked, userRow('sent')])).toBeNull()
    expect(extractPendingAsk([asked, interrupted('stopped')])).toBeNull()
  })

  it('bounds scan and dismissal serialization work across N/10N calls and readbacks', () => {
    function measure(callCount: number, titleLength = 32) {
      let blockReads = 0
      const rows = Array.from({ length: callCount }, (_, index) => {
        const id = String(index).padStart(4, '0')
        return message(`row-${id}`, [
          {
            get type() {
              blockReads += 1
              return 'tool-call' as const
            },
            name: 'request_user_input_async',
            callId: `call-${id}`,
            input: { questions: [{ title: 'é'.repeat(titleLength) }] }
          }
        ])
      })
      const stringify = JSON.stringify
      function read(messages: NativeChatMessage[]) {
        blockReads = 0
        let serializedBytes = 0
        let serializations = 0
        // Observe real serialization, including any intermediate occurrence strings.
        const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value) => {
          const encoded = stringify(value)
          serializedBytes += new TextEncoder().encode(encoded).byteLength
          serializations += 1
          return encoded
        })
        try {
          const key = nativeChatAskDismissKey(extractPendingMessageReplyAsk(messages))
          return { key, blockReads, serializedBytes, serializations }
        } finally {
          spy.mockRestore()
        }
      }

      const first = read(rows)
      expect(first.key).not.toBeNull()
      expect(first.blockReads).toBeGreaterThanOrEqual(callCount)
      expect(first.blockReads).toBeLessThanOrEqual(2 * callCount)
      expect(first.serializations).toBeLessThanOrEqual(2)
      expect(first.serializedBytes).toBeGreaterThan(callCount * titleLength * 2)
      expect(first.serializedBytes).toBeLessThanOrEqual(callCount * (512 + 4 * titleLength))
      for (let readback = 0; readback < 3; readback += 1) {
        expect(read(rows.map((row) => ({ ...row, blocks: [...row.blocks] })))).toEqual(first)
      }

      const noAsync = rows.map((row) =>
        message(
          row.id,
          row.blocks.map(() => ({
            get type() {
              blockReads += 1
              return 'tool-call' as const
            },
            name: 'Bash',
            input: {}
          }))
        )
      )
      expect(read(noAsync)).toEqual({
        key: null,
        blockReads: first.blockReads,
        serializedBytes: 0,
        serializations: 0
      })
      expect(read([...rows, userRow('delivered')])).toMatchObject({
        key: null,
        blockReads: first.blockReads,
        serializedBytes: 0,
        serializations: 0
      })
      const replacement = message('new-0000', [asyncCall('call-0000', 'é'.repeat(titleLength))])
      const replaced = read([...rows, userRow('delivered'), replacement])
      expect(replaced.key).not.toBe(first.key)
      expect(replaced.serializedBytes).toBe(read([replacement]).serializedBytes)
      return first
    }

    const small = measure(24)
    const large = measure(240)
    expect(large.blockReads).toBeLessThanOrEqual(10 * small.blockReads)
    expect(large.serializedBytes).toBeLessThanOrEqual(10 * small.serializedBytes)
    // Grow text independently of call count: the bound includes full UTF-8 question content.
    const longQuestions = measure(24, 320)
    expect(longQuestions.serializedBytes).toBeGreaterThan(2 * small.serializedBytes)
    expect(longQuestions.serializedBytes).toBeLessThanOrEqual(10 * small.serializedBytes)
  })
})
