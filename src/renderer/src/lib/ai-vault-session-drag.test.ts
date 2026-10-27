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
import { buildAgentTerminalResumePlan } from '../../../shared/agent-terminal-resume-plan'
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

function historyState(unrelatedEnv: Record<string, string>): AiVaultResumeWorktreeArgs['state'] {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    repos: [],
    worktreesByRepo: {},
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
  const session = { agent: 'claude' as const, sessionId, cwd: '/repo', codexHome: null }
  const args = { state, session, worktreeId: state.activeWorktreeId }
  const startup = buildAiVaultResumeDragStartupForWorktree(args)
  const realHomeStartup = buildAiVaultResumeDragStartupForWorktree({
    ...args,
    session: { ...session, codexHome: null }
  })
  const transfer = createTransfer()
  writeAiVaultLocalDragData(transfer, {
    agent: session.agent,
    sessionId,
    title: 'Claude session',
    ...startup,
    sessionFilePath: '/sessions/claude.jsonl',
    sessionExecutionHostId: 'local',
    codexHome: session.codexHome,
    sessionCwd: session.cwd,
    realHomeStartup
  })
  const serialized = transfer.getData(AI_VAULT_SESSION_DRAG_TYPE)
  const privateSerialized = transfer.getData(AI_VAULT_LOCAL_DRAG_TYPE)
  clearAiVaultSessionDragData()
  const payload = readAiVaultSessionDragData(transfer)
  expect(payload).not.toBeNull()
  const selected = payload ? readAiVaultLocalDragData(transfer, payload)?.normal : undefined
  return { serialized, privateSerialized, payload, selected, startup, args }
}

function serializedLeaves(value: unknown): number {
  return value !== null && typeof value === 'object'
    ? Object.values(value).reduce<number>((sum, child) => sum + serializedLeaves(child), 0)
    : 1
}

function effectiveDragResume(payload: AiVaultResumeDragStartup | null | undefined) {
  if (!payload?.resume) {
    throw new Error('Expected typed History drag')
  }
  const plan = buildAgentTerminalResumePlan({
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    resume: payload.resume,
    settings: { agentDefaultArgs: { claude: '--model host' } },
    runtime: {
      platform: 'linux',
      pty: { shellOverride: undefined, terminalWindowsWslDistro: null }
    },
    isRemote: false
  })
  if (!plan) {
    throw new Error('Expected a buildable selected recipe')
  }
  return plan
}

describe('Session History session drag data', () => {
  afterEach(() => {
    clearAiVaultSessionDragData()
  })

  it('bounds actual startup clones and drag serialization at a fixed viewport for unrelated env N/10N', () => {
    const samples = [100, 1000].map((size) => {
      const state = historyState(
        Object.fromEntries(
          Array.from({ length: size }, (_, index) => [`UNUSED_${index}`, 'unrelated-value'])
        )
      )
      const clone = vi.spyOn(globalThis, 'structuredClone')
      try {
        const drags = Array.from({ length: 8 }, (_, index) =>
          historyDrag(state, `session-${index}`)
        )
        expect(clone).toHaveBeenCalledTimes(16)
        const cloneInputs = clone.mock.calls.map(([input]) => JSON.stringify(input) ?? '')
        for (const serialized of [
          ...cloneInputs,
          ...drags.flatMap((drag) => [drag.serialized, drag.privateSerialized])
        ]) {
          expect(serialized).not.toContain('UNUSED_')
          expect(serialized).not.toContain('"codex":')
        }
        const count = (serialized: string) => serializedLeaves(JSON.parse(serialized))
        return {
          cloneLeaves: cloneInputs.map(count),
          cloneBytes: cloneInputs.map((text) => new TextEncoder().encode(text).byteLength),
          dragLeaves: drags.flatMap(({ serialized, privateSerialized }) => [
            count(serialized),
            count(privateSerialized)
          ]),
          dragBytes: drags.flatMap(({ serialized, privateSerialized }) =>
            [serialized, privateSerialized].map(
              (value) => new TextEncoder().encode(value).byteLength
            )
          )
        }
      } finally {
        clone.mockRestore()
      }
    })
    expect(samples[1]).toEqual(samples[0])
    for (const bytes of samples[1]!.dragBytes) {
      expect(bytes).toBeGreaterThan(0)
      expect(bytes).toBeLessThan(AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES)
    }
  })

  it.each([100, 1000])('skips nonlocal catalog visits for eight History rows at C=%i', (size) => {
    let visits = 0
    const state = {
      ...historyState({}),
      activeWorktreeId: 'repo::active',
      activeWorkspaceExecutionHostId: 'ssh:target' as const,
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
      expect(drag.startup).toEqual(buildAiVaultResumeForWorktree(drag.args, false))
      expect(drag.selected).toBeUndefined()
      expect(drag.privateSerialized).toBe('')
    }
    expect(visits).toBe(0)
    const local = historyDrag({ ...state, activeWorkspaceExecutionHostId: 'local' as const })
    expect(effectiveDragResume(local.selected).env).toEqual({ SELECTED: 'first' })
  })

  it('keeps the 9000-character unrelated env drag valid and selected changes effective', () => {
    const state = historyState({ UNUSED: 'x'.repeat(9000) })
    const first = historyDrag(state)
    expect(new TextEncoder().encode(first.serialized).byteLength).toBeLessThan(
      AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES
    )
    expect(first.selected?.resume?.recipe).toMatchObject({
      source: 'current-inputs',
      settings: {
        agentCmdOverrides: { claude: 'selected-claude' },
        agentDefaultArgs: { claude: '--model first' },
        agentDefaultEnv: { claude: { SELECTED: 'first' } },
        agentPermissionDefault: 'ask',
        agentPermissionOverrides: { claude: 'full-access' }
      }
    })
    if (!state.settings) {
      throw new Error('Missing fixture settings')
    }
    state.settings.agentCmdOverrides = { claude: 'changed-claude' }
    state.settings.agentDefaultArgs = { claude: '--model second' }
    state.settings.agentDefaultEnv!.claude = { SELECTED: 'second' }
    state.settings.agentPermissionOverrides = { claude: 'accept-edits' }
    const second = historyDrag(state)
    const originalPlan = effectiveDragResume(first.selected)
    const changedPlan = effectiveDragResume(second.selected)
    expect(originalPlan.launchCommand).toContain('selected-claude')
    expect(originalPlan.launchCommand).toContain('first')
    expect(originalPlan.launchCommand).toContain('--dangerously-skip-permissions')
    expect(originalPlan.env).toEqual({ SELECTED: 'first' })
    expect(changedPlan.launchCommand).toContain('changed-claude')
    expect(changedPlan.launchCommand).toContain('second')
    expect(changedPlan.launchCommand).toContain('acceptEdits')
    expect(changedPlan.launchCommand).not.toContain('--dangerously-skip-permissions')
    expect(changedPlan.env).toEqual({ SELECTED: 'second' })
    state.settings.agentPermissionOverrides = {}
    const inherited = effectiveDragResume(historyDrag(state).selected)
    expect(inherited.launchCommand).toContain('default')
    expect(inherited.launchCommand).not.toContain('acceptEdits')
  })

  it('writes and reads the private session history payload', () => {
    const transfer = createTransfer()
    const payload: AiVaultSessionDragPayload = {
      agent: 'claude',
      sessionId: 'session-1',
      title: 'Fix terminal split',
      command: "cd '/repo' && claude --resume session-1",
      sessionFilePath: '/Users/ada/.claude/projects/-repo/session-1.jsonl',
      codexHome: '/Users/ada/Library/Application Support/orca/codex-runtime-home/home',
      sessionCwd: '/repo',
      env: { ANTHROPIC_BASE_URL: 'https://claude.example.test' },
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
      launchConfig: {
        agentCommand: 'claude --dangerously-skip-permissions',
        agentArgs: '--dangerously-skip-permissions',
        agentEnv: { ANTHROPIC_BASE_URL: 'https://claude.example.test' }
      },
      realHomeStartup: {
        command: "cd '/repo' && claude --resume session-1",
        envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME']
      }
    }

    writeAiVaultSessionDragData(transfer, payload)

    expect(transfer.effectAllowed).toBe('copy')
    expect(hasAiVaultSessionDragData(transfer)).toBe(true)
    expect(readAiVaultSessionDragData(transfer)).toEqual(payload)
  })

  it('requires executable parent commands while old readers ignore private-only fields', () => {
    const { payload } = historyDrag(historyState({}))
    const transfer = createTransfer()
    for (const command of [undefined, '']) {
      transfer.setData(
        AI_VAULT_SESSION_DRAG_TYPE,
        JSON.stringify({
          kind: 'ai-vault-session',
          version: 1,
          ...payload,
          command
        })
      )
      expect(readAiVaultSessionDragData(transfer)).toBeNull()
    }
    transfer.setData(
      AI_VAULT_SESSION_DRAG_TYPE,
      JSON.stringify({
        kind: 'ai-vault-session',
        version: 1,
        ...payload,
        resume: { unknown: true }
      })
    )
    expect(readAiVaultSessionDragData(transfer)).toEqual(payload)
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
    const transfer = createTransfer()
    for (const change of [
      { sessionFilePath: '   ' },
      { agent: 'bad' },
      { env: ['ANTHROPIC_BASE_URL=https://claude.example.test'] },
      { envToDelete: ['CODEX_HOME', ''] },
      { launchConfig: { agentArgs: '', agentEnv: ['ANTHROPIC_BASE_URL=invalid'] } },
      { realHomeStartup: { command: '' } }
    ]) {
      transfer.setData(
        AI_VAULT_SESSION_DRAG_TYPE,
        JSON.stringify({
          kind: 'ai-vault-session',
          version: 1,
          agent: 'claude',
          sessionId: 'session-1',
          title: 'Malformed payload',
          command: 'claude --resume session-1',
          ...change
        })
      )
      expect(readAiVaultSessionDragData(transfer)).toBeNull()
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

  it('does not retain an oversized internal payload for the hidden-data fallback', () => {
    const source = createTransfer()
    writeAiVaultSessionDragData(source, {
      agent: 'claude',
      sessionId: 'session-oversized',
      title: 'Oversized payload',
      command: 'x'.repeat(AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES)
    })

    const dropTransfer = new TypeOnlyDataTransfer() as unknown as DataTransfer
    dropTransfer.setData(AI_VAULT_SESSION_DRAG_TYPE, '')

    expect(readAiVaultSessionDragData(dropTransfer)).toBeNull()
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

it('uses the cross-window same-local selected recipe without compatibility env becoming caller env', async () => {
  const pending = await drop(drag({ state, worktreeId: 'folder:source', session }))
  expect(pending.resume?.recipe).toMatchObject({
    source: 'current-inputs',
    settings: { agentDefaultEnv: { claude: { SELECTED: 'source' } } }
  })
  expect(pending.env).toBeUndefined()
  expect(pending.launchConfig).toBeUndefined()
  expect(pending.resumeProviderSession).toEqual({ key: 'session_id', id: 'saved' })
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
  const transport = createIpcPtyTransport({
    ...pending,
    worktreeId: wt,
    tabId: 'tab',
    leafId: 'leaf'
  })
  const accepted = vi.fn()
  const onError = vi.fn()
  const result = await transport.connect({
    url: '',
    cols: 80,
    rows: 24,
    callbacks: { onStartupAccepted: accepted, onError }
  })
  expect(onError).not.toHaveBeenCalled()
  expect(window.api.pty.spawn).toHaveBeenCalledOnce()
  expect(vi.mocked(window.api.pty.spawn).mock.calls[0]?.[0].command).toBeUndefined()
  expect(plans[0]?.command).toContain(`team'"'"'s model`)
  expect(plans[0]?.env).toEqual({ SELECTED: 'source' })
  const effective = {
    id: 'preferred',
    launchAgent: 'claude',
    resumeProviderSession: { key: 'session_id', id: 'saved' }
  }
  expect(result).toMatchObject(effective)
  expect(accepted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(effective))
  transport.detach?.()
})

it('keeps actual click/drop H1/H2 literal fallback and absence after real C1 null, never after unknown', async () => {
  for (const literal of [undefined, 'custom-claude']) {
    state.settings = createGlobalSettingsFixture({
      agentCmdOverrides: literal ? {} : { claude: 'custom-claude' },
      agentDefaultArgs: { claude: '"' },
      agentDefaultEnv: { claude: { SELECTED: 'recipe' } }
    })
    const args = { state, worktreeId: 'folder:source', session, commandOverride: literal }
    for (const entry of ['click', 'drop'] as const) {
      createTab.mockClear()
      if (entry === 'drop') {
        await drop(drag(args))
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
      vi.mocked(window.api.pty.spawn).mockImplementation(async (request) => {
        if (request.resume) {
          await planPreferred(request)
          throw new Error('Malformed recipe unexpectedly planned')
        }
        return { id: 'ordinary', incarnationId: 'inc' }
      })
      const transport = createIpcPtyTransport({
        ...pending,
        worktreeId: wt,
        tabId: 'tab',
        leafId: 'leaf',
        onPtySpawn: () => {
          throw new Error('presentation failed')
        }
      })
      vi.mocked(window.api.pty.spawn).mockClear()
      const accepted = vi.fn()
      await transport.connect({
        url: '',
        cols: 121,
        rows: 37,
        callbacks: { onStartupAccepted: accepted }
      })
      const calls = vi.mocked(window.api.pty.spawn).mock.calls
      expect(calls).toHaveLength(2)
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
      expect(accepted).toHaveBeenCalledOnce()
      transport.detach?.()
      vi.mocked(window.api.pty.spawn).mockRejectedValue(new Error('lost reply'))
      const unknown = createIpcPtyTransport({
        ...pending,
        worktreeId: wt,
        tabId: 'tab',
        leafId: 'leaf'
      })
      vi.mocked(window.api.pty.spawn).mockClear()
      await unknown.connect({ url: '', cols: 121, rows: 37, callbacks: {} })
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

it('keeps LONG3000 and near-cap parent bytes while the actual local drop plans the selected env', async () => {
  state.settings = createGlobalSettingsFixture({
    agentPermissionDefault: 'own',
    agentDefaultArgs: { claude: '' },
    agentDefaultEnv: { claude: { LONG: '' } }
  })
  const args = { state, worktreeId: 'folder:source', session }
  const emptySize = new TextEncoder().encode(parentBytes(args)).byteLength
  const nearCap = Math.floor((AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES - emptySize) / 4)
  for (const size of [3000, nearCap]) {
    createTab.mockClear()
    const env = { LONG: 'x'.repeat(size) }
    state.settings.agentDefaultEnv = { claude: env }
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
    const plans: Awaited<ReturnType<typeof planPreferred>>[] = []
    vi.mocked(window.api.pty.spawn).mockImplementation(async (request) => {
      const planned = await planPreferred(request)
      plans.push(planned)
      return {
        id: 'long',
        incarnationId: 'inc',
        launchAgent: planned.launchAgent,
        resumeProviderSession: planned.resumeProviderSession
      }
    })
    vi.mocked(window.api.pty.spawn).mockClear()
    const transport = createIpcPtyTransport({
      ...pending,
      worktreeId: wt,
      tabId: 'tab',
      leafId: 'leaf'
    })
    const accepted = vi.fn()
    const onError = vi.fn()
    const result = await transport.connect({
      url: '',
      cols: 80,
      rows: 24,
      callbacks: { onStartupAccepted: accepted, onError }
    })
    expect(onError).not.toHaveBeenCalled()
    expect(window.api.pty.spawn).toHaveBeenCalledOnce()
    expect(vi.mocked(window.api.pty.spawn).mock.calls[0]?.[0].resume?.recipe).toMatchObject({
      settings: { agentDefaultEnv: { claude: env } }
    })
    expect(plans[0]?.env).toEqual(env)
    const effective = {
      id: 'long',
      launchAgent: 'claude',
      resumeProviderSession: { key: 'session_id', id: 'saved' }
    }
    expect(result).toMatchObject(effective)
    expect(accepted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(effective))
    transport.detach?.()
  }
})

it('keeps red/blue null-plan env distinct despite identical parent bytes', async () => {
  let previous: string | undefined
  for (const color of ['red', 'blue']) {
    createTab.mockClear()
    state.settings = createGlobalSettingsFixture({
      agentPermissionDefault: 'own',
      agentDefaultArgs: { claude: '"' },
      agentDefaultEnv: { claude: { SELECTED: color } }
    })
    const transfer = drag({ state, worktreeId: 'folder:source', session })
    const parent = transfer.getData(AI_VAULT_SESSION_DRAG_TYPE)
    if (previous) {
      expect(parent).toBe(previous)
    }
    previous = parent
    const pending = await drop(transfer)
    vi.mocked(window.api.pty.spawn).mockImplementation(async (request) => {
      if (request.resume) {
        await planPreferred(request)
        throw new Error('Malformed input unexpectedly planned')
      }
      return { id: 'ordinary', incarnationId: 'inc' }
    })
    vi.mocked(window.api.pty.spawn).mockClear()
    const transport = createIpcPtyTransport({
      ...pending,
      worktreeId: wt,
      tabId: 'tab',
      leafId: 'leaf'
    })
    const accepted = vi.fn()
    const onError = vi.fn()
    const result = await transport.connect({
      url: '',
      cols: 80,
      rows: 24,
      callbacks: { onStartupAccepted: accepted, onError }
    })
    expect(onError).not.toHaveBeenCalled()
    const calls = vi.mocked(window.api.pty.spawn).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[0].resume?.recipe).toMatchObject({
      settings: { agentDefaultEnv: { claude: { SELECTED: color } } }
    })
    expect(calls[1]?.[0].env).toBeUndefined()
    expect(result).toBe('ordinary')
    expect(accepted).toHaveBeenCalledExactlyOnceWith({ id: 'ordinary', incarnationId: 'inc' })
    transport.detach?.()
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
