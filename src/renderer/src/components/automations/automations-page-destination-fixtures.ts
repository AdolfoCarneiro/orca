import { act } from 'react'
import { expect, vi } from 'vitest'
import type { HookCheckResult } from '@/runtime/runtime-hooks-client'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { loadHostStructuredAgents } from '@/runtime/host-structured-agents'
import type { Automation } from '../../../../shared/automations-types'
import type { Repo } from '../../../../shared/repo-types'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY as LIST_HOST_SCOPE,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY as OWNER_FENCING,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY as CREATE_IDEMPOTENCY,
  AUTOMATION_SURFACE_RUNTIME_CAPABILITY,
  AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import {
  api,
  addRuntimeProject,
  mocks,
  renderPage,
  runtimeHost,
  RUNTIME_ID,
  RUNTIME_REPO_ID,
  RUNTIME_WORKSPACE_ID,
  RUNTIME_SELF_FILTER,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeAutomation } from './automations-page-fixtures'
import type { AutomationDraft } from './AutomationEditorDialog'

export const CHAT_CAPABILITIES = [
  LIST_HOST_SCOPE,
  OWNER_FENCING,
  CREATE_IDEMPOTENCY,
  AUTOMATION_SURFACE_RUNTIME_CAPABILITY,
  AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
]

export function draftRecord(current: unknown): object {
  if (current === null || typeof current !== 'object') {
    throw new Error('Missing editor draft')
  }
  return current
}

export function observeRuntimeChat(capabilities: string[] | null): void {
  mocks.state.runtimeStatusByEnvironmentId = new Map(
    capabilities === null ? [] : [[RUNTIME_ID, { status: { capabilities } }]]
  )
}

export function capableChatDestination(): void {
  observeRuntimeChat(CHAT_CAPABILITIES)
  mocks.getRuntimeEnvironmentStatus.mockResolvedValue({ capabilities: CHAT_CAPABILITIES })
}

export const SSH_TARGET_ID = 'ssh-target-1'
export const SSH_REPO_ID = 'repo-ssh'
export const SSH_HOST_KEY = hostStableKey({
  authority: { kind: 'desktop' },
  selector: { kind: 'ssh', targetId: SSH_TARGET_ID }
})

export const DESKTOP_SELF_KEY = hostStableKey({
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
})
export const RUNTIME_SELF_KEY = hostStableKey({
  authority: { kind: 'runtime', environmentId: RUNTIME_ID },
  selector: { kind: 'self' }
})

/** A desktop-registered SSH host, with the generation that makes it fenceable. */
export function addSshHost(): void {
  mocks.state.sshTargetLabels = new Map([[SSH_TARGET_ID, 'openclaw']])
  mocks.state.sshTargetGenerations = new Map([[SSH_TARGET_ID, 1]])
  mocks.state.sshConnectionStates = new Map([[SSH_TARGET_ID, { status: 'connected' }]])
}

/** A project checked out on that SSH host rather than locally. */
export function addSshProject(): void {
  const repo: Repo = {
    id: SSH_REPO_ID,
    displayName: 'orca',
    path: '/repos/orca',
    badgeColor: '#222222',
    addedAt: 1,
    worktreeBaseRef: 'main',
    connectionId: SSH_TARGET_ID
  }
  mocks.state.repos = [...(mocks.state.repos as Repo[]), repo]
  mocks.repoMap.set(SSH_REPO_ID, repo)
  // The host needs a ready setup or save refuses the project before choosing a destination.
  mocks.state.projectHostSetups = [
    ...mocks.state.projectHostSetups,
    {
      id: 'setup-ssh',
      projectId: 'project-ssh',
      hostId: `ssh:${SSH_TARGET_ID}`,
      repoId: SSH_REPO_ID,
      path: '/repos/orca',
      displayName: 'orca',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }
  ]
}

/** The runtime answers a create; without this the RPC double returns an empty result. */
export function runtimeCreateReturns(automation: Automation): void {
  const previous = mocks.callRuntimeRpc.getMockImplementation()
  mocks.callRuntimeRpc.mockImplementation(
    async (target: unknown, method: string, params: unknown, options: unknown) => {
      if (method === 'automation.create') {
        return { automation }
      }
      return await previous?.(target, method, params, options)
    }
  )
}

export async function save(): Promise<void> {
  await act(async () => {
    mocks.editorDialog?.onSave()
  })
}

export function createRpcCalls(): unknown[][] {
  return mocks.callRuntimeRpc.mock.calls.filter((call) => call[1] === 'automation.create')
}

export const REGISTERED_CHAT_CAPABILITIES = [
  ...CHAT_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
]

export function observeRuntimeIncarnation(
  runtimeId: string,
  capabilities = REGISTERED_CHAT_CAPABILITIES
): void {
  const status = { runtimeId, capabilities }
  mocks.state.runtimeStatusByEnvironmentId = new Map([[RUNTIME_ID, { status }]])
  mocks.getRuntimeEnvironmentStatus.mockResolvedValue(status)
}

export async function learnRuntimeAgents(runtimeId: string, agents: string[]): Promise<void> {
  const previous = mocks.callRuntimeRpc.getMockImplementation()
  mocks.callRuntimeRpc.mockImplementation(async (target, method, params, options) =>
    method === 'agentSession.agents'
      ? { agents: agents.map((agent) => ({ agent, capabilities: {} })) }
      : await previous?.(target, method, params, options)
  )
  try {
    await loadHostStructuredAgents(`runtime:${RUNTIME_ID}`, REGISTERED_CHAT_CAPABILITIES, runtimeId)
  } finally {
    mocks.callRuntimeRpc.mockImplementation(previous ?? (() => ({})))
  }
}

export async function openCreateDialogFor(projectId: string, workspaceId: string): Promise<void> {
  await act(async () => {
    mocks.listPanel?.openCreateDialog()
  })
  await act(async () => {
    mocks.editorDialog?.onDraftChange((current) => ({
      ...draftRecord(current),
      name: 'Sweep',
      prompt: 'Do the sweep',
      projectId,
      workspaceMode: 'existing',
      workspaceId
    }))
  })
}

export async function holdRuntimeSave(
  draft: Partial<AutomationDraft> = {},
  initialAgents = ['pi']
) {
  api.automations.list.mockResolvedValue([])
  scopedList([])
  runtimeHost([], [])
  addRuntimeProject()
  mocks.state.settings = { ...getDefaultSettings('/tmp'), experimentalNativeChat: true }
  mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
  observeRuntimeIncarnation('A')
  await learnRuntimeAgents('A', initialAgents)
  runtimeCreateReturns(makeAutomation({ id: 'a-new' }))
  const held = Promise.withResolvers<HookCheckResult>()
  vi.mocked(checkRuntimeHooks).mockReturnValue(held.promise)
  const page = await renderPage()
  await settleHostQueries()
  await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
  await act(async () => {
    mocks.editorDialog?.onDraftChange((current) => ({
      ...draftRecord(current),
      agentId: 'pi',
      workspaceMode: 'new_per_run',
      workspaceId: '',
      ...draft
    }))
  })
  await save()
  expect(checkRuntimeHooks).toHaveBeenCalledWith(`runtime:${RUNTIME_ID}`, RUNTIME_REPO_ID, {})
  expect(createRpcCalls()).toHaveLength(0)
  return {
    page,
    async release() {
      await act(async () => {
        held.resolve({ status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false })
      })
      await settleHostQueries()
    }
  }
}
