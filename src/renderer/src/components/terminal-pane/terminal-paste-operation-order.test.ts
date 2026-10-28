import { describe, expect, it, vi } from 'vitest'

import { sendAgentDraftPasteContent } from '@/lib/agent-draft-paste-content'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  wrapTerminalBracketedPasteText
} from './terminal-bracketed-paste'
import { executeTerminalPastePlan } from './terminal-paste-executor'
import { planTerminalPaste } from './terminal-paste-coordinator'
import { runTerminalPtyInputTransaction } from './terminal-pty-input-transaction'

function chunkedWindowsPaste() {
  return planTerminalPaste(chunkedWindowsPasteArgs())
}

function chunkedWindowsPasteArgs() {
  return {
    text: 'user-line-1\nuser-line-2',
    source: 'keyboard',
    target: {
      kind: 'terminal',
      paneId: 1,
      leafId: 'leaf-1',
      ptyId: 'pty-1',
      runtime: {
        platform: 'win32',
        runtimeKey: 'local:win32',
        kind: 'local',
        isWindowsConpty: true
      }
    },
    terminalBracketedPasteMode: true,
    maxDirectBytes: 4,
    maxChunkBytes: 12
  } satisfies Parameters<typeof planTerminalPaste>[0]
}

describe('terminal paste operation ordering', () => {
  it('starts an uncontended paste operation synchronously', async () => {
    let started = false
    const operation = runTerminalPtyInputTransaction('pty-1', async () => {
      started = true
    })

    expect(started).toBe(true)
    await operation
  })

  it('writes submit input before a paste queued behind it', async () => {
    const writes: string[] = []
    let queued: Promise<unknown> | null = null
    const writePty = async (data: string): Promise<boolean> => {
      writes.push(data)
      return true
    }

    const result = await executeTerminalPastePlan(chunkedWindowsPaste(), {
      pasteText: () => {},
      writePty,
      submitInput: '\r',
      yieldToEventLoop: async () => {
        queued ??= executeTerminalPastePlan(chunkedWindowsPaste(), {
          pasteText: () => {},
          writePty
        })
      }
    })
    await queued

    expect(result.status).toBe('pasted')
    const firstFrameEnd = writes.indexOf(BRACKETED_PASTE_END)
    expect(writes[firstFrameEnd + 1]).toBe('\r')
    expect(writes[firstFrameEnd + 2]).toBe(BRACKETED_PASTE_START)
  })

  it('sends submit input by the direct paste route so input guards drop both', async () => {
    const typed: string[] = []
    const writePty = vi.fn(async () => true)
    const plan = planTerminalPaste({
      ...chunkedWindowsPasteArgs(),
      maxDirectBytes: 1024
    })

    const result = await executeTerminalPastePlan(plan, {
      pasteText: (text) => {
        typed.push(`paste:${text}`)
      },
      writePty,
      submitInput: '\r',
      typeInput: (data) => typed.push(data)
    })

    expect(result.status).toBe('pasted')
    expect(typed).toEqual(['paste:user-line-1\nuser-line-2', '\r'])
    expect(writePty).not.toHaveBeenCalled()
  })

  it('times out a stalled submit write and releases the PTY for the next paste', async () => {
    let submitAborted = false
    const result = await executeTerminalPastePlan(chunkedWindowsPaste(), {
      pasteText: () => {},
      writePty: async (data, signal) => {
        if (data !== '\r') {
          return true
        }
        return await new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => {
            submitAborted = true
            resolve(false)
          })
        })
      },
      submitInput: '\r',
      operationTimeoutMs: 10
    })

    expect(result).toMatchObject({ status: 'cancelled', reason: 'operation-timeout' })
    expect(submitAborted).toBe(true)
    let nextStarted = false
    await runTerminalPtyInputTransaction('pty-1', async () => {
      nextStarted = true
    })
    expect(nextStarted).toBe(true)
  })

  it('keeps startup context outside an active chunked user paste frame', async () => {
    const writes: string[] = []
    let startupDraft: Promise<boolean> | null = null
    const writePty = async (data: string): Promise<boolean> => {
      writes.push(data)
      return true
    }

    const userPasteResult = await executeTerminalPastePlan(chunkedWindowsPaste(), {
      pasteText: () => {},
      writePty,
      yieldToEventLoop: async () => {
        startupDraft ??= sendAgentDraftPasteContent(
          'pty-1',
          'GENERATED_CONTEXT',
          'launch',
          writePty
        )
      }
    })
    await startupDraft

    expect(userPasteResult.status).toBe('pasted')
    expect(writes).toEqual([
      BRACKETED_PASTE_START,
      'user-line-1\r',
      'user-line-2',
      BRACKETED_PASTE_END,
      wrapTerminalBracketedPasteText('GENERATED_CONTEXT')
    ])
  })

  it('waits for an active startup frame before opening a user paste frame', async () => {
    const writes: { owner: 'startup' | 'user'; data: string }[] = []
    let releaseStartup!: () => void
    let startupOpened!: () => void
    const opened = new Promise<void>((resolve) => {
      startupOpened = resolve
    })
    const startup = sendAgentDraftPasteContent(
      'pty-1',
      'G'.repeat(64 * 1024 + 1),
      'launch',
      async (data) => {
        writes.push({ owner: 'startup', data })
        if (data === BRACKETED_PASTE_START) {
          startupOpened()
          await new Promise<void>((resolve) => {
            releaseStartup = resolve
          })
        }
        return true
      }
    )
    await opened

    const user = executeTerminalPastePlan(chunkedWindowsPaste(), {
      pasteText: () => {},
      writePty: async (data) => {
        writes.push({ owner: 'user', data })
        return true
      },
      yieldToEventLoop: async () => {}
    })
    await Promise.resolve()
    expect(writes).toEqual([{ owner: 'startup', data: BRACKETED_PASTE_START }])

    releaseStartup()
    await expect(Promise.all([startup, user])).resolves.toEqual([
      true,
      expect.objectContaining({ status: 'pasted' })
    ])
    const firstUserWrite = writes.findIndex(({ owner }) => owner === 'user')
    expect(firstUserWrite).toBeGreaterThan(0)
    expect(writes.slice(0, firstUserWrite).every(({ owner }) => owner === 'startup')).toBe(true)
    expect(writes.slice(firstUserWrite).every(({ owner }) => owner === 'user')).toBe(true)
    expect(writes[firstUserWrite]?.data).toBe(BRACKETED_PASTE_START)
    expect(writes.at(-1)?.data).toBe(BRACKETED_PASTE_END)
  })

  it('does not block paste operations for another PTY', async () => {
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const first = runTerminalPtyInputTransaction('pty-1', async () => {
      firstStarted()
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    })
    await started

    await expect(
      runTerminalPtyInputTransaction('pty-2', async () => 'second-complete')
    ).resolves.toBe('second-complete')
    releaseFirst()
    await first
  })

  it('releases a PTY after a failed paste operation', async () => {
    await expect(
      runTerminalPtyInputTransaction('pty-1', async () => {
        throw new Error('write failed')
      })
    ).rejects.toThrow('write failed')

    await expect(runTerminalPtyInputTransaction('pty-1', async () => 'recovered')).resolves.toBe(
      'recovered'
    )
  })
})
