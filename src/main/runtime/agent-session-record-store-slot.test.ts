import './orca-runtime-test-mocks.spec'
import { store as runtimeStore } from './orca-runtime-test-fixtures.spec'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { subscribeCrew } from './orchestration/crew/crew-stream'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { sessionCrewChanges } from './orchestration/crew/crew-changes'
/** Early launch admission and the later chat host must share one record-store writer. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  openAgentSessionRecordStoreOnce,
  peekOpenedAgentSessionRecordStore,
  releaseAgentSessionRecordStore
} from './agent-session-record-store-slot'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const HOST_ID = 'local'
let stateDirectory: string

function location(directory = stateDirectory) {
  return {
    stateDirectory: directory,
    hostId: HOST_ID,
    logger: createStructuredAgentSessionLogger()
  }
}

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-record-store-slot-'))
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  vi.restoreAllMocks()
  await rm(stateDirectory, { recursive: true, force: true })
})

describe('the record store slot', () => {
  it('hands every caller the same store', async () => {
    const [first, second] = await Promise.all([
      openAgentSessionRecordStoreOnce(location()),
      openAgentSessionRecordStoreOnce(location())
    ])

    expect(second.store).toBe(first.store)
  })

  it('builds a chat host installed after admission on the store admission opened', async () => {
    const { store } = await openAgentSessionRecordStoreOnce(location())
    const close = vi.spyOn(JournalHostDatabase.prototype, 'close')

    const host = await ensureStructuredAgentSessionHost({
      ...location(),
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory,
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveEnvironment: async () => ({}),
      resolveLaunchArgs: () => []
    })
    expect(host.deps.store).toBe(store)

    await stopStructuredAgentSessionRuntime()
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes a store no chat host was built on when the runtime stops', async () => {
    const { store } = await openAgentSessionRecordStoreOnce(location())
    const close = vi.spyOn(JournalHostDatabase.prototype, 'close')

    await stopStructuredAgentSessionRuntime()

    expect(close).toHaveBeenCalledOnce()
    const reopened = await openAgentSessionRecordStoreOnce(location())
    expect(reopened.store).not.toBe(store)
  })

  it('refuses a second profile rather than opening a second store', async () => {
    await openAgentSessionRecordStoreOnce(location())
    const elsewhere = await mkdtemp(join(tmpdir(), 'orca-record-store-slot-other-'))
    try {
      await expect(openAgentSessionRecordStoreOnce(location(elsewhere))).rejects.toThrow(
        'agent_session_record_store_location_changed'
      )
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('lets the next caller retry after an open fails', async () => {
    const notADirectory = join(stateDirectory, 'profile-file')
    await writeFile(notADirectory, 'not a profile')

    await expect(openAgentSessionRecordStoreOnce(location(notADirectory))).rejects.toThrow()
    await expect(openAgentSessionRecordStoreOnce(location())).resolves.toMatchObject({
      store: expect.anything()
    })
  })
})

it('publishes source installation and release even when opening an empty record store', async () => {
  const observed: unknown[] = []
  const stop = sessionCrewChanges.subscribe(() =>
    observed.push(peekOpenedAgentSessionRecordStore())
  )
  try {
    const first = await openAgentSessionRecordStoreOnce(location())
    expect(observed).toEqual([first.store])
    await openAgentSessionRecordStoreOnce(location())
    expect(observed).toEqual([first.store])
    const released = await releaseAgentSessionRecordStore()
    expect(observed).toEqual([first.store, null])
    released?.journalDatabase.close()
  } finally {
    stop()
  }
})

it('retires a sole Crew observer generation on empty-source open, real name writes, host install/replacement and release', async () => {
  const now = 1_800_000_000_000
  vi.useFakeTimers({ now })
  const runtime = new OrcaRuntimeService(runtimeStore)
  const db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  const captures = vi.spyOn(runtime, 'createTerminalIdentityRawInputs')
  const frames: unknown[] = []
  const flush = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }
  const read = () => runtime.getOrchestrationCrewSnapshot('term_source_coordinator')
  const stop = subscribeCrew(read, runtime.watchOrchestrationCrew, (frame) => frames.push(frame))
  try {
    await flush()
    expect(captures).toHaveBeenCalledOnce()
    const opened = await openAgentSessionRecordStoreOnce(location())
    await flush()
    expect(captures).toHaveBeenCalledTimes(2)
    await openAgentSessionRecordStoreOnce(location())
    await flush()
    expect(captures).toHaveBeenCalledTimes(2)
    const sessionId = 'chat-source-availability-0001'
    await opened.store.reserveOwner({
      sessionId,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      },
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/tmp/unused-source-fixture' },
      expectedFence: null,
      spawnToken: 'source-only-no-process',
      claimKeyId: 'key-1',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'fixture',
        operationId: `${now}-${'a'.repeat(32)}`,
        fingerprint: 'source-availability'
      },
      now
    })
    await opened.store.setConversationName(sessionId, 'Available chat')
    const message = db.insertMessage({
      from: 'term_source_coordinator',
      to: `orca_session_id:${sessionId}`,
      subject: 'Recent peer'
    })
    db.db
      .prepare('UPDATE messages SET created_at = ? WHERE sequence = ?')
      .run(new Date(now).toISOString(), message.sequence)
    await flush()
    expect(read().sections.talkingWith[0].label).toBe('Available chat')
    const host = await ensureStructuredAgentSessionHost({
      ...location(),
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory,
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveEnvironment: async () => ({}),
      resolveLaunchArgs: () => []
    })
    await flush()
    const afterInstall = captures.mock.calls.length
    setStructuredAgentSessionHost(host)
    await flush()
    expect(captures).toHaveBeenCalledTimes(afterInstall)
    setStructuredAgentSessionHost(null)
    await flush()
    expect(captures).toHaveBeenCalledTimes(afterInstall + 1)
    setStructuredAgentSessionHost(host)
    await flush()
    expect(captures).toHaveBeenCalledTimes(afterInstall + 2)
    const beforeRename = captures.mock.calls.length
    await opened.store.setConversationName(sessionId, 'Renamed without process')
    await flush()
    expect(captures).toHaveBeenCalledTimes(beforeRename)
    expect(read().sections.talkingWith[0].label).toBe('Renamed without process')
    await stopStructuredAgentSessionRuntime()
    await flush()
    expect(captures.mock.calls.length).toBeGreaterThan(beforeRename)
    expect(read().sections.talkingWith[0].label).not.toBe('Renamed without process')
    stop()
    const afterStop = captures.mock.calls.length
    await openAgentSessionRecordStoreOnce(location())
    await flush()
    expect(captures).toHaveBeenCalledTimes(afterStop)
    expect(frames.length).toBeGreaterThan(2)
  } finally {
    stop()
    await stopStructuredAgentSessionRuntime()
    db.close()
    vi.useRealTimers()
  }
})
