// @vitest-environment happy-dom
import {
  buildAiVaultResumeDragStartupForWorktree,
  type AiVaultResumeDragStartup
} from './ai-vault-session-drag-startup'
import {
  AI_VAULT_LOCAL_DRAG_TYPE,
  writeAiVaultLocalDragData,
  readAiVaultLocalDragData
} from './ai-vault-local-drag-data'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { materializeAiVaultResumeForTest } from './ai-vault-resume-startup.test-fixture'
import {
  buildAiVaultResumeForWorktree,
  type AiVaultResumeWorktreeArgs
} from './ai-vault-resume-command'
import { makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
import { resolveTerminalHostOwnership } from './terminal-worktree-route'
import {
  AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES,
  AI_VAULT_SESSION_DRAG_TYPE,
  clearAiVaultSessionDragData,
  hasAiVaultSessionDragData,
  readAiVaultSessionDragData,
  writeAiVaultSessionDragData,
  type AiVaultSessionDragPayload
} from './ai-vault-session-drag'

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import AiVaultSessionDropLayer from '../components/tab-group/AiVaultSessionDropLayer'
import { buildAiVaultResumeStartupForWorktree } from './ai-vault-resume-command'
import {
  makeFolderWorkspace,
  makeTerminalTab,
  TEST_REPO
} from '../store/slices/worktrees-slice-test-fixtures'
import { resolveAgentTerminalCreateOptions } from '../../../main/runtime/runtime-agent-terminal-startup'
import { partialRuntimeStore } from '../../../main/runtime/runtime-store-partial-fixture'
import { mapRuntimeError } from '../../../main/runtime/rpc/errors'
import { createIpcPtyTransport } from '../components/terminal-pane/pty-transport'
import {
  installIpcPtyWindow,
  restorePtySpecWindow
} from '../components/terminal-pane/pty-transport-test-harness'
import { launchAiVaultSessionInNewTab } from './launch-ai-vault-session'
import type { AppState } from '@/store/types'

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))

class FakeDataTransfer {
  effectAllowed = 'all'
  types: string[] = []
  private readonly data = new Map<string, string>()

  setData(type: string, value: string): void {
    if (!this.types.includes(type)) {
      this.types.push(type)
    }
    this.data.set(type, value)
  }

  getData(type: string): string {
    return this.data.get(type) ?? ''
  }
}

class TypeOnlyDataTransfer extends FakeDataTransfer {
  override getData(_type: string): string {
    return ''
  }
}

function createTransfer(): DataTransfer {
  return new FakeDataTransfer() as unknown as DataTransfer
}

const codecPayload: AiVaultSessionDragPayload = {
  agent: 'codex',
  sessionId: 'session-1',
  title: 'Session History',
  command: 'codex resume session-1'
}
function parentTransfer(change: Record<string, unknown>) {
  const transfer = createTransfer()
  transfer.setData(
    AI_VAULT_SESSION_DRAG_TYPE,
    JSON.stringify({
      kind: 'ai-vault-session',
      version: 1,
      ...codecPayload,
      ...change
    })
  )
  return transfer
}

function historyState(unrelatedEnv: Record<string, string>): AiVaultResumeWorktreeArgs['state'] {
  return {
    ...sourceState(),
    settings: createGlobalSettingsFixture({
      agentCmdOverrides: { claude: 'selected-claude', codex: 'unused-codex' },
      agentDefaultArgs: { claude: '--model first', codex: '--model unused' },
      agentDefaultEnv: { claude: { SELECTED: 'first' }, codex: unrelatedEnv },
      agentPermissionDefault: 'ask',
      agentPermissionOverrides: { claude: 'full-access', codex: 'own' }
    })
  }
}

function historyDrag(state: AiVaultResumeWorktreeArgs['state'], sessionId = 'session-1') {
  const args = { state, worktreeId: state.activeWorktreeId, session: { ...session, sessionId } }
  const transfer = drag(args)
  const serialized = transfer.getData(AI_VAULT_SESSION_DRAG_TYPE)
  const privateSerialized = transfer.getData(AI_VAULT_LOCAL_DRAG_TYPE)
  const payload = readAiVaultSessionDragData(transfer)
  expect(payload).not.toBeNull()
  const selected = payload ? readAiVaultLocalDragData(transfer, payload)?.normal : undefined
  return { serialized, privateSerialized, selected, args }
}

async function effectiveDragResume(drag: ReturnType<typeof historyDrag>) {
  if (!drag.selected?.resume) {
    throw new Error('Expected typed History drag')
  }
  return materializeAiVaultResumeForTest(drag.args, drag.selected)
}

describe('Session History session drag data', () => {
  afterEach(() => {
    clearAiVaultSessionDragData()
  })

  it('bounds actual History production at C/U N/10N and a fixed eight-row viewport', async () => {
    const samples = []
    for (const size of [100, 1000]) {
      let visits = 0
      const state: AiVaultResumeWorktreeArgs['state'] & {
        activeWorkspaceExecutionHostId: 'local' | 'ssh:target'
      } = {
        ...historyState(
          Object.fromEntries(
            Array.from({ length: size }, (_, index) => [`UNUSED_${index}`, 'unrelated-value'])
          )
        ),
        activeWorktreeId: 'repo::active',
        activeWorkspaceExecutionHostId: 'ssh:target',
        worktreesByRepo: {
          repo: Array.from({ length: size }, (_, index) => ({
            ...makeWorktree({ repoId: 'repo', id: `repo::unrelated-${index}` }),
            get id() {
              visits += 1
              return `repo::unrelated-${index}`
            }
          }))
        }
      }
      expect(resolveTerminalHostOwnership(state, state.activeWorktreeId, 'spawn').kind).toBe(
        'local-or-ssh'
      )
      expect(visits).toBe(size)
      visits = 0
      for (let index = 0; index < 8; index += 1) {
        const drag = historyDrag(state, `session-${index}`)
        expect(drag.serialized).toBe(parentBytes(drag.args))
        expect(drag.selected).toBeUndefined()
        expect(drag.privateSerialized).toBe('')
      }
      expect(visits).toBe(0)
      state.activeWorkspaceExecutionHostId = 'local'
      const clone = vi.spyOn(globalThis, 'structuredClone')
      try {
        const drags = Array.from({ length: 8 }, (_, index) =>
          historyDrag(state, `session-${index}`)
        )
        expect(clone).toHaveBeenCalledTimes(16)
        const inputs = [
          ...clone.mock.calls.map(([input]) => JSON.stringify(input) ?? ''),
          ...drags.flatMap(({ serialized, privateSerialized }) => [serialized, privateSerialized])
        ]
        for (const text of inputs) {
          expect(text).not.toContain('UNUSED_')
          expect(text).not.toContain('"codex":')
          expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(0)
          expect(new TextEncoder().encode(text).byteLength).toBeLessThan(
            AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES
          )
        }
        samples.push(inputs)
        expect((await effectiveDragResume(drags[0]!)).env).toEqual({ SELECTED: 'first' })
      } finally {
        clone.mockRestore()
      }
    }
    expect(samples[1]).toEqual(samples[0])
  })

  it('keeps the 9000-character unrelated env drag valid and selected changes effective', async () => {
    const state = historyState({ UNUSED: 'x'.repeat(9000) })
    const first = historyDrag(state)
    expect(new TextEncoder().encode(first.serialized).byteLength).toBeLessThan(
      AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES
    )
    if (!state.settings) {
      throw new Error('Missing fixture settings')
    }
    state.settings.agentCmdOverrides = { claude: 'changed-claude' }
    state.settings.agentDefaultArgs = { claude: '--model second' }
    state.settings.agentDefaultEnv!.claude = { SELECTED: 'second' }
    state.settings.agentPermissionOverrides = { claude: 'accept-edits' }
    const second = historyDrag(state)
    const originalPlan = await effectiveDragResume(first)
    const changedPlan = await effectiveDragResume(second)
    expect(originalPlan.command).toContain('selected-claude')
    expect(originalPlan.command).toContain('first')
    expect(originalPlan.command).toContain('--dangerously-skip-permissions')
    expect(originalPlan.env).toEqual({ SELECTED: 'first' })
    expect(changedPlan.command).toContain('changed-claude')
    expect(changedPlan.command).toContain('second')
    expect(changedPlan.command).toContain('acceptEdits')
    expect(changedPlan.command).not.toContain('--dangerously-skip-permissions')
    expect(changedPlan.env).toEqual({ SELECTED: 'second' })
    state.settings.agentPermissionOverrides = {}
    const inherited = await effectiveDragResume(historyDrag(state))
    expect(inherited.command).toContain('default')
    expect(inherited.command).not.toContain('acceptEdits')
  })

  it('requires executable commands while old readers ignore private fields', () => {
    for (const command of [undefined, '']) {
      expect(readAiVaultSessionDragData(parentTransfer({ command }))).toBeNull()
    }
    expect(readAiVaultSessionDragData(parentTransfer({ resume: { unknown: true } }))).toEqual(
      codecPayload
    )
  })

  it('preserves an explicit null sessionCwd across the serialized round-trip', () => {
    const transfer = createTransfer()
    const payload: AiVaultSessionDragPayload = {
      agent: 'codex',
      sessionId: 'session-3',
      title: 'Session without a recorded cwd',
      command: 'codex resume session-3',
      sessionFilePath: '/tmp/orca/codex-accounts/a/home/sessions/2026/07/20/rollout-x.jsonl',
      codexHome: '/tmp/orca/codex-accounts/a/home',
      sessionCwd: null
    }

    writeAiVaultSessionDragData(transfer, payload)

    const read = readAiVaultSessionDragData(transfer)
    expect(read).toEqual(payload)
    // Explicit null (no cwd) must stay distinguishable from an absent key (old serializer).
    expect(read && 'sessionCwd' in read).toBe(true)
  })

  it('round-trips a structured session without a legacy resume command', () => {
    const transfer = createTransfer()
    const payload: AiVaultSessionDragPayload = {
      agent: 'codex',
      sessionId: 'session-structured',
      structuredSession: { sessionId: 'session-structured', workspaceId: 'worktree-1' },
      title: 'Native chat',
      command: ''
    }

    writeAiVaultSessionDragData(transfer, payload)

    expect(readAiVaultSessionDragData(transfer)).toEqual(payload)
  })

  it('keeps sessionCwd absent when an older serializer omitted it', () => {
    const transfer = createTransfer()
    transfer.setData(
      AI_VAULT_SESSION_DRAG_TYPE,
      JSON.stringify({
        kind: 'ai-vault-session',
        version: 1,
        agent: 'codex',
        sessionId: 'session-4',
        title: 'Old-window payload',
        command: 'codex resume session-4'
      })
    )

    const read = readAiVaultSessionDragData(transfer)
    expect(read).not.toBeNull()
    expect(read && 'sessionCwd' in read).toBe(false)
  })

  it('rejects malformed parent paths, agents, env, deletion and launch config records', () => {
    for (const change of [
      { sessionFilePath: '   ' },
      { agent: 'bad' },
      { env: ['ANTHROPIC_BASE_URL=https://claude.example.test'] },
      { envToDelete: ['CODEX_HOME', ''] },
      { launchConfig: { agentArgs: '', agentEnv: ['ANTHROPIC_BASE_URL=invalid'] } },
      { realHomeStartup: { command: '' } }
    ]) {
      expect(readAiVaultSessionDragData(parentTransfer(change))).toBeNull()
    }
  })

  it('rejects oversized serialized payloads before parsing', () => {
    const transfer = createTransfer()
    const secret = 'ai-vault-drag-secret'
    transfer.setData(
      AI_VAULT_SESSION_DRAG_TYPE,
      secret + 'x'.repeat(AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES)
    )

    expect(readAiVaultSessionDragData(transfer)).toBeNull()
  })

  it('rejects multibyte oversized payloads before parsing', () => {
    const transfer = createTransfer()
    transfer.setData(AI_VAULT_SESSION_DRAG_TYPE, '😀'.repeat(4097))

    expect(readAiVaultSessionDragData(transfer)).toBeNull()
  })

  it('falls back to the active renderer drag payload when Chromium hides custom data', () => {
    const source = createTransfer()
    const payload: AiVaultSessionDragPayload = {
      agent: 'codex',
      sessionId: 'session-2',
      title: 'Resume a hidden payload',
      command: "cd '/repo' && codex resume session-2"
    }
    writeAiVaultSessionDragData(source, payload)

    const dropTransfer = new TypeOnlyDataTransfer() as unknown as DataTransfer
    dropTransfer.setData(AI_VAULT_SESSION_DRAG_TYPE, '')

    expect(hasAiVaultSessionDragData(dropTransfer)).toBe(true)
    expect(readAiVaultSessionDragData(dropTransfer)).toEqual(payload)

    clearAiVaultSessionDragData()
    expect(readAiVaultSessionDragData(dropTransfer)).toBeNull()

    writeAiVaultSessionDragData(source, {
      ...codecPayload,
      command: 'x'.repeat(AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES)
    })
    expect(readAiVaultSessionDragData(dropTransfer)).toBeNull()
  })
})

const mocks = vi.hoisted(() => ({ getState: vi.fn(), prepare: vi.fn(), error: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultTerminalResumeRequest: mocks.prepare
}))
vi.mock('@/lib/launch-agent-tab-order', () => ({ persistAgentLaunchTabOrder: vi.fn() }))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => false
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error, success: vi.fn() } }))

const wt = 'repo1::wt'
function sourceState(): AiVaultResumeWorktreeArgs['state'] {
  return {
    activeRepoId: 'repo1',
    activeWorktreeId: 'folder:source',
    projects: [],
    projectGroups: [],
    folderWorkspaces: [
      makeFolderWorkspace({ id: 'source', folderPath: 'C:\\work', executionHostId: 'local' })
    ],
    repos: [
      { ...TEST_REPO, path: 'C:\\work\\a' },
      { ...TEST_REPO, id: 'repo2', path: 'C:\\work\\b' }
    ],
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: wt,
          repoId: 'repo1',
          path: String.raw`\\wsl.localhost\Ubuntu\home\alice\project`
        })
      ]
    },
    settings: createGlobalSettingsFixture({
      terminalWindowsShell: 'powershell.exe',
      agentDefaultArgs: { claude: '--model "team\'s model"' },
      agentDefaultEnv: { claude: { SELECTED: 'source' } }
    })
  }
}
const session = {
  agent: 'claude' as const,
  sessionId: 'saved',
  cwd: null,
  codexHome: null,
  executionHostId: 'local',
  filePath: String.raw`\\wsl.localhost\Ubuntu\home\alice\.claude\projects\p\saved.jsonl`
}
const createTab = vi.fn<AppState['createTab']>(() => makeTerminalTab({ id: 'tab', worktreeId: wt }))
let state = sourceState()
const domWindow = globalThis.window
const originalApi = domWindow.api
beforeEach(() => {
  vi.clearAllMocks()
  installIpcPtyWindow(domWindow, {})
  const api = window.api
  restorePtySpecWindow(domWindow)
  window.api = api
  state = sourceState()
  mocks.getState.mockImplementation(() => ({ ...state, createTab, setActiveTabType: vi.fn() }))
  mocks.prepare.mockResolvedValue({ useRealCodexHome: false })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 100, 100)
  )
})
afterEach(() => {
  cleanup()
  window.api = originalApi
  clearAiVaultSessionDragData()
  vi.restoreAllMocks()
})

function sourcePayload(args: AiVaultResumeWorktreeArgs, selected: boolean) {
  const build = selected
    ? buildAiVaultResumeDragStartupForWorktree
    : (input: AiVaultResumeWorktreeArgs) => buildAiVaultResumeForWorktree(input, false)
  const startup: AiVaultResumeDragStartup = build(args)
  const realHomeStartup = build({ ...args, session: { ...args.session, codexHome: null } })
  return {
    agent: args.session.agent,
    sessionId: args.session.sessionId,
    title: 'Saved',
    command: startup.command,
    ...(startup.resume ? { resume: startup.resume, localFallback: startup.localFallback } : {}),
    sessionFilePath: args.session.filePath,
    sessionExecutionHostId: args.session.executionHostId,
    codexHome: args.session.codexHome,
    sessionCwd: args.session.cwd ?? null,
    ...(startup.env ? { env: startup.env } : {}),
    ...(startup.envToDelete ? { envToDelete: startup.envToDelete } : {}),
    ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {}),
    realHomeStartup
  }
}
function drag(args: AiVaultResumeWorktreeArgs, transfer = createTransfer()) {
  writeAiVaultLocalDragData(transfer, sourcePayload(args, true))
  clearAiVaultSessionDragData()
  return transfer
}
function parentBytes(args: AiVaultResumeWorktreeArgs) {
  const transfer = createTransfer()
  writeAiVaultSessionDragData(transfer, sourcePayload(args, false))
  return transfer.getData(AI_VAULT_SESSION_DRAG_TYPE)
}
async function drop(transfer: ReturnType<typeof drag>) {
  const view = render(
    createElement(
      'div',
      {},
      createElement('div', { 'data-tab-group-body-id': 'group', 'data-worktree-id': wt }),
      createElement(AiVaultSessionDropLayer, { enabled: true, worktreeId: wt })
    )
  )
  const pane = view.container.querySelector('[data-tab-group-body-id="group"]')
  if (!pane) {
    throw new Error('Missing real drop target')
  }
  expect(transfer.effectAllowed).toBe('copy')
  const parent = readAiVaultSessionDragData(transfer)
  expect(parent).not.toBeNull()
  expect(hasAiVaultSessionDragData(transfer)).toBe(true)
  expect(pane.getAttribute('data-worktree-id')).toBe(wt)
  expect(pane.getBoundingClientRect()).toMatchObject({ left: 0, top: 0, right: 100, bottom: 100 })
  const event = new Event('drop', { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries({ dataTransfer: transfer, clientX: 50, clientY: 50 })) {
    Object.defineProperty(event, key, { value })
  }
  const delivered = vi.fn()
  window.addEventListener('drop', delivered, { capture: true, once: true })
  const preparedBefore = mocks.prepare.mock.calls.length
  try {
    fireEvent(pane, event)
    expect(delivered).toHaveBeenCalledExactlyOnceWith(event)
    expect(event).toMatchObject({
      type: 'drop',
      target: pane,
      dataTransfer: transfer,
      clientX: 50,
      clientY: 50
    })
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() => {
      expect(mocks.error.mock.calls).toEqual([])
      expect(mocks.prepare).toHaveBeenCalledTimes(preparedBefore + 1)
      expect(createTab).toHaveBeenCalledOnce()
    })
    expect(mocks.prepare).toHaveBeenLastCalledWith({
      agent: parent?.agent,
      sessionId: parent?.sessionId,
      filePath: parent?.sessionFilePath,
      executionHostId: parent?.sessionExecutionHostId,
      codexHome: parent?.codexHome ?? null
    })
    expect(createTab.mock.calls[0]?.slice(0, 3)).toEqual([wt, 'group', undefined])
    const pending = createTab.mock.calls[0]?.[3]?.pendingStartup
    if (!pending) {
      throw new Error('Missing queued startup')
    }
    expect(pending).not.toHaveProperty('localFallback')
    return pending
  } finally {
    window.removeEventListener('drop', delivered, true)
    view.unmount()
  }
}

async function planPreferred(request: Parameters<typeof window.api.pty.spawn>[0]) {
  try {
    return await resolveAgentTerminalCreateOptions(
      { id: 'wt', path: '/repo', repo: null, folderWorkspace: null, connectionId: null },
      {
        startupAgent: request.launchAgent ?? 'claude',
        resume: request.resume,
        env: request.env,
        launchRuntime: { platform: 'linux', pty: {} }
      },
      { store: partialRuntimeStore(), hostIdentity: 'local', toSessionOptions: () => undefined }
    )
  } catch (error) {
    const response = mapRuntimeError('history', { runtimeId: 'local' }, error)
    throw Object.assign(new Error(response.error.message), { response })
  }
}

type Pending = Awaited<ReturnType<typeof drop>>
const placement = { worktreeId: wt, tabId: 'tab', leafId: 'leaf' }
function paneTransport(pending: Parameters<typeof createIpcPtyTransport>[0]) {
  return createIpcPtyTransport({ ...pending, ...placement })
}
async function connectObserved(
  pending: Parameters<typeof createIpcPtyTransport>[0],
  geometry = { cols: 80, rows: 24 }
) {
  const transport = paneTransport(pending)
  const accepted = vi.fn()
  const onError = vi.fn()
  const result = await transport.connect({
    url: '',
    ...geometry,
    callbacks: { onStartupAccepted: accepted, onError }
  })
  return { transport, accepted, onError, result }
}
async function connectPreferred(pending: Pending, env: Record<string, string>) {
  expect(pending.launchAgent).toBe('claude')
  const plans: Awaited<ReturnType<typeof planPreferred>>[] = []
  vi.mocked(window.api.pty.spawn).mockImplementation(async (request) => {
    const planned = await planPreferred(request)
    plans.push(planned)
    return {
      id: 'preferred',
      incarnationId: 'inc',
      launchAgent: planned.launchAgent,
      resumeProviderSession: planned.resumeProviderSession
    }
  })
  vi.mocked(window.api.pty.spawn).mockClear()
  const { transport, accepted, onError, result } = await connectObserved(pending)
  expect(onError).not.toHaveBeenCalled()
  expect(window.api.pty.spawn).toHaveBeenCalledOnce()
  const request = vi.mocked(window.api.pty.spawn).mock.calls[0]?.[0]
  expect(request?.command).toBeUndefined()
  expect(request?.resume?.recipe).toMatchObject({
    settings: { agentDefaultEnv: { claude: env } }
  })
  expect(plans[0]?.env).toEqual(env)
  const effective = {
    id: 'preferred',
    launchAgent: 'claude',
    resumeProviderSession: { key: 'session_id', id: 'saved' }
  }
  expect(result).toMatchObject(effective)
  expect(accepted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(effective))
  transport.detach?.()
  return plans[0]
}
function refusePreferred() {
  vi.mocked(window.api.pty.spawn).mockImplementation(async (request) => {
    if (request.resume) {
      await planPreferred(request)
      throw new Error('Malformed recipe unexpectedly planned')
    }
    return { id: 'ordinary', incarnationId: 'inc' }
  })
}

it.each(['folder:source', wt])(
  'keeps %s source-prepared quote/home bytes for SSH and the version1 projection',
  async (sourceWorktreeId) => {
    const args = {
      state,
      worktreeId: sourceWorktreeId,
      session: {
        ...session,
        agent: 'codex' as const,
        codexHome: String.raw`\\wsl.localhost\Ubuntu\home\alice\custom-codex`,
        filePath: String.raw`\\wsl.localhost\Ubuntu\home\alice\custom-codex\sessions\saved.jsonl`
      }
    }
    state.settings = createGlobalSettingsFixture({
      terminalWindowsShell: 'powershell.exe',
      agentDefaultArgs: { codex: '--model "team\'s model"' },
      agentDefaultEnv: { codex: { SELECTED: 'source' } }
    })
    const prepared = buildAiVaultResumeForWorktree(args, false)
    const transfer = drag(args)
    expect(transfer.getData(AI_VAULT_SESSION_DRAG_TYPE)).toBe(parentBytes(args))
    const reads = vi.spyOn(transfer, 'getData')
    const old = JSON.parse(transfer.getData(AI_VAULT_SESSION_DRAG_TYPE))
    expect(JSON.stringify([old.command, old.env, old.envToDelete, old.launchConfig])).toBe(
      JSON.stringify([prepared.command, prepared.env, prepared.envToDelete, prepared.launchConfig])
    )
    state = {
      ...state,
      repos: state.repos.map((repo) => ({
        ...repo,
        executionHostId: 'ssh:ubuntu',
        connectionId: 'ubuntu'
      }))
    }
    const pending = await drop(transfer)
    expect(
      JSON.stringify([pending.command, pending.env, pending.envToDelete, pending.launchConfig])
    ).toBe(
      JSON.stringify([prepared.command, prepared.env, prepared.envToDelete, prepared.launchConfig])
    )
    expect(pending).not.toHaveProperty('resume')
    expect(reads).not.toHaveBeenCalledWith(AI_VAULT_LOCAL_DRAG_TYPE)
    expect(pending.resumeProviderSession).toEqual(prepared.providerSession)
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.not.objectContaining({ localFallback: expect.anything(), resume: expect.anything() })
    )
  }
)

it('keeps H1/H2 click/drop fallback, red/blue provenance and unknown outcomes distinct', async () => {
  for (const literal of [undefined, 'custom-claude']) {
    let previous: string | undefined
    const cases = [
      ['click', 'recipe'],
      ['drop', 'red'],
      ['drop', 'blue']
    ] as const
    for (const [entry, color] of cases) {
      state.settings = createGlobalSettingsFixture({
        agentCmdOverrides: literal ? {} : { claude: 'custom-claude' },
        agentDefaultArgs: { claude: '"' },
        agentDefaultEnv: { claude: { SELECTED: color } }
      })
      const args = { state, worktreeId: 'folder:source', session, commandOverride: literal }
      createTab.mockClear()
      if (entry === 'drop') {
        const transfer = drag(args)
        const parent = transfer.getData(AI_VAULT_SESSION_DRAG_TYPE)
        if (previous) {
          expect(parent).toBe(previous)
        }
        previous = parent
        await drop(transfer)
      } else {
        launchAiVaultSessionInNewTab({
          agent: 'claude',
          worktreeId: wt,
          ...buildAiVaultResumeStartupForWorktree(args)
        })
      }
      const pending = createTab.mock.calls[0]?.[3]?.pendingStartup
      if (!pending) {
        throw new Error('Missing queued startup')
      }
      refusePreferred()
      vi.mocked(window.api.pty.spawn).mockClear()
      const { transport, accepted, onError, result } = await connectObserved(
        {
          ...pending,
          ...(entry === 'click'
            ? {
                onPtySpawn: () => {
                  throw new Error('presentation failed')
                }
              }
            : {})
        },
        { cols: 121, rows: 37 }
      )
      const calls = vi.mocked(window.api.pty.spawn).mock.calls
      expect(calls).toHaveLength(2)
      expect(calls[0]?.[0].resume?.recipe).toMatchObject({
        settings: { agentDefaultEnv: { claude: { SELECTED: color } } }
      })
      expect(calls[1]?.[0]).toMatchObject({
        command: pending.command,
        launchAgent: undefined,
        resume: undefined,
        launchConfig: undefined,
        env: undefined,
        resumeProviderSession: entry === 'drop' ? { key: 'session_id', id: 'saved' } : undefined,
        cols: 121,
        rows: 37,
        tabId: 'tab',
        leafId: 'leaf'
      })
      expect(pending.command.startsWith(literal ?? 'claude')).toBe(true)
      expect(accepted).toHaveBeenCalledExactlyOnceWith({ id: 'ordinary', incarnationId: 'inc' })
      if (entry === 'drop') {
        expect(onError).not.toHaveBeenCalled()
        expect(result).toBe('ordinary')
      } else {
        expect(onError).toHaveBeenCalledExactlyOnceWith('presentation failed')
      }
      transport.detach?.()
      vi.mocked(window.api.pty.spawn).mockRejectedValue(new Error('lost reply'))
      vi.mocked(window.api.pty.spawn).mockClear()
      const { transport: unknown, onError: lost } = await connectObserved(pending)
      expect(lost).toHaveBeenCalledExactlyOnceWith('lost reply')
      expect(window.api.pty.spawn).toHaveBeenCalledOnce()
      unknown.detach?.()
    }
  }
})

it.each(['real-home', 'repin'] as const)(
  'keeps the existing %s preparation owner through the actual drop',
  async (kind) => {
    const codex = {
      ...session,
      agent: 'codex' as const,
      codexHome: '/recorded-home',
      filePath: String.raw`\\wsl.localhost\Ubuntu\home\alice\custom-codex\sessions\saved.jsonl`
    }
    state.settings = createGlobalSettingsFixture({
      agentPermissionDefault: 'own',
      agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' }
    })
    mocks.prepare.mockResolvedValue(
      kind === 'real-home'
        ? { useRealCodexHome: true }
        : { useRealCodexHome: false, substituteCodexHome: '/selected-home' }
    )
    const pending = await drop(drag({ state, worktreeId: 'folder:source', session: codex }))
    expect(pending.resume?.codexHome).toBe(kind === 'real-home' ? null : '/selected-home')
    expect(pending.env).toBeUndefined()
    expect(pending.resume?.recipe).toMatchObject({
      settings: {
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' }
      }
    })
  }
)

it('keeps cross-window selected, LONG3000 and near-cap parent input through the actual local drop', async () => {
  const ordinarySettings = state.settings
  state.settings = createGlobalSettingsFixture({
    agentPermissionDefault: 'own',
    agentDefaultArgs: { claude: '' },
    agentDefaultEnv: { claude: { LONG: '' } }
  })
  const args = { state, worktreeId: 'folder:source', session }
  const emptySize = new TextEncoder().encode(parentBytes(args)).byteLength
  const nearCap = Math.floor((AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES - emptySize) / 4)
  const largeSettings = state.settings
  for (const size of [0, 3000, nearCap]) {
    createTab.mockClear()
    const env: Record<string, string> =
      size === 0 ? { SELECTED: 'source' } : { LONG: 'x'.repeat(size) }
    state.settings = size === 0 ? ordinarySettings : largeSettings
    state.settings!.agentDefaultEnv = { claude: env }
    const expected = parentBytes(args)
    const transfer = drag(args)
    expect(transfer.getData(AI_VAULT_SESSION_DRAG_TYPE)).toBe(expected)
    expect(readAiVaultSessionDragData(transfer)).not.toBeNull()
    if (size === nearCap) {
      expect(
        AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES - new TextEncoder().encode(expected).byteLength
      ).toBeLessThan(4)
    }
    const pending = await drop(transfer)
    expect(pending.env).toBeUndefined()
    expect(pending.launchConfig).toBeUndefined()
    expect(pending.resumeProviderSession).toEqual({ key: 'session_id', id: 'saved' })
    const planned = await connectPreferred(pending, env)
    if (size === 0) {
      expect(planned?.command).toContain(`team'"'"'s model`)
    }
  }
})

it('uses prepared local input for missing, mismatched, malformed and oversized items without stale values', async () => {
  const args = { state, worktreeId: 'folder:source', session }
  const expected = buildAiVaultResumeForWorktree(args, false)
  const other = drag({ ...args, session: { ...session, sessionId: 'different' } })
  const valid = JSON.parse(drag(args).getData(AI_VAULT_LOCAL_DRAG_TYPE))
  for (const item of [
    '',
    other.getData(AI_VAULT_LOCAL_DRAG_TYPE),
    '{',
    JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ ...valid, normal: { ...valid.normal, fallback: { literal: 999999 } } })
  ]) {
    createTab.mockClear()
    const transfer = drag(args)
    transfer.setData(AI_VAULT_LOCAL_DRAG_TYPE, item)
    const pending = await drop(transfer)
    expect(pending).not.toHaveProperty('resume')
    expect(pending.command).toBe(expected.command)
    expect(pending.env).toEqual(expected.env)
    expect(pending.launchConfig).toEqual(expected.launchConfig)
  }
  const reused = drag(args)
  state.settings = createGlobalSettingsFixture({
    agentDefaultArgs: { claude: '"' },
    agentDefaultEnv: { claude: { LONG: 'x'.repeat(17000) } }
  })
  const rewritten = drag({ ...args, state }, reused)
  expect(rewritten.getData(AI_VAULT_LOCAL_DRAG_TYPE)).toBe('')
  expect(rewritten.getData(AI_VAULT_SESSION_DRAG_TYPE)).toBe(parentBytes({ ...args, state }))
  createTab.mockClear()
  expect(await drop(rewritten)).not.toHaveProperty('resume')
})
