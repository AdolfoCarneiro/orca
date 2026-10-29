import { expect, it, vi } from 'vitest'
import { agentMessageDisplayText } from './agent-message-display-text'
import { readAgentMessageSource } from './agent-session-message-source'
import { agentMessageHeading } from './agent-message-presentation'
import { ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX } from '../orca-dispatch-status-prompt'

const task = readAgentMessageSource({
  kind: 'agent',
  senders: [],
  orchestration: { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
})!
it('gates the memo on provenance, keeps images, and derives the heading from every parsed sender', () => {
  const blocks = [
    { type: 'text', text: `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\r\n=== TASK ===\r\n  task  ` },
    { type: 'image-ref', path: '/image.png' }
  ] as const
  expect(agentMessageDisplayText(blocks, task)).toBe('  task  ')
  expect(agentMessageDisplayText(blocks)).toBeUndefined()
  expect(
    agentMessageDisplayText([...blocks, { type: 'tool-result', output: 'not display input' }], task)
  ).toBeUndefined()
  expect(agentMessageDisplayText([...blocks, { type: 'text', text: '' }], task)).toBeUndefined()
  expect(agentMessageHeading(task)).toBe('task')
  for (const suffix of ['', '  task 🐋\r\n\r\n=== TASK ===\nmy marker  ']) {
    const raw = `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\nOriginal instructions\n=== TASK ===\n${suffix}`
    expect(agentMessageDisplayText([{ type: 'text', text: raw }], task)).toBe(suffix)
    expect(
      agentMessageDisplayText(
        [{ type: 'text', text: raw.replace('Original instructions', 'Edited instructions') }],
        task
      )
    ).toBe(suffix)
    expect(agentMessageDisplayText([{ type: 'text', text: `${raw}edited` }], task)).toBe(
      `${suffix}edited`
    )
  }
  for (const text of [
    'unrecognized',
    `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\n${'x'.repeat(24_576)}\n=== TASK ===\nlate`,
    blocks[0].text.replace('multi-agent IDE', 'changed')
  ]) {
    expect(agentMessageDisplayText([{ type: 'text', text }], task)).toBeUndefined()
  }
  for (const [relations, expected] of [
    [[], 'generic'],
    [['worker'], 'worker'],
    [['coordinator', 'coordinator'], 'coordinator'],
    [['none'], 'generic'],
    [['future'], 'generic'],
    [['worker', 'coordinator'], 'generic'],
    [['worker', 'worker', 'worker', 'future'], 'generic']
  ] as const) {
    const parsed = readAgentMessageSource({
      kind: 'agent',
      orchestration: { message: 'mail-notice', mailbox: 'term_a', dispatchId: null, messages: [] },
      senders: relations.map((relation, i) => ({
        party: { address: `term_${i}`, terminalHandle: `term_${i}`, orcaSessionId: null },
        name: 'Sender',
        relation
      }))
    })!
    expect(agentMessageHeading(parsed)).toBe(expected)
    expect(parsed.senders).toHaveLength(relations.length)
  }
})
it.each([100, 1000])(
  'bounds actual grammar searches and memoizes immutable blocks at %i tasks',
  (n) => {
    let searched = 0,
      calls = 0
    let recognizing = false
    const original = String.prototype.indexOf
    const search = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string,
      ...args
    ) {
      if (recognizing) {
        calls++
        searched += this.length
      }
      return original.apply(this, args)
    })
    try {
      const raw = `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\n${'instructions '.repeat(500)}\n=== TASK ===\n${'task '.repeat(6000)}`
      const inputs = Array.from(
        { length: n },
        () =>
          [
            {
              type: 'text',
              text: raw
            }
          ] as const
      )
      const read = (blocks: Parameters<typeof agentMessageDisplayText>[0]) => {
        recognizing = true
        try {
          return agentMessageDisplayText(blocks, task)
        } finally {
          recognizing = false
        }
      }
      for (const blocks of inputs) {
        expect(read(blocks)).toHaveLength(30_000)
      }
      expect(calls).toBe(n)
      expect(searched).toBe(n * 24_576)
      const before = { calls, searched }
      for (const blocks of inputs) {
        read(blocks)
      }
      expect({ calls, searched }).toEqual(before)
      for (const blocks of inputs) {
        read([{ type: 'text', text: `${blocks[0].text}edited` }])
      }
      expect(calls).toBe(before.calls * 2)
    } finally {
      search.mockRestore()
    }
  }
)
