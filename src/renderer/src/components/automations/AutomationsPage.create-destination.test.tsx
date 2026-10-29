// @vitest-environment happy-dom

/** Choose, display and revalidate the storage destination explicitly; workspace execution cannot infer authority, and stale destinations must preserve the refused form. */

import { act } from 'react'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  AUTOMATION_SURFACE_RUNTIME_CAPABILITY,
  AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
} from '../../../../shared/protocol-version'
import type { HookCheckResult } from '@/runtime/runtime-hooks-client'
import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import { unscopedAutomationListRows, type AutomationListRow } from './automation-list-row-identity'
import {
  addRuntimeProject,
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  runtimeHost,
  RUNTIME_ID,
  RUNTIME_REPO_ID,
  RUNTIME_SELF_FILTER,
  RUNTIME_WORKSPACE_ID,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { listedRow } from './automations-page-listed-items'
import { makeAutomation, REPO_ID, WORKSPACE_ID } from './automations-page-fixtures'
import type { Repo } from '../../../../shared/repo-types'

installAutomationsPageHarness()

const CHAT_CAPABILITIES = [
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  AUTOMATION_SURFACE_RUNTIME_CAPABILITY,
  AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
]

function draftRecord(current: unknown): object {
  if (current === null || typeof current !== 'object') {
    throw new Error('Missing editor draft')
  }
  return current
}

function observeRuntimeChat(capabilities: string[] | null): void {
  mocks.state.runtimeStatusByEnvironmentId = new Map(
    capabilities === null ? [] : [[RUNTIME_ID, { status: { capabilities } }]]
  )
}

function capableChatDestination(): void {
  observeRuntimeChat(CHAT_CAPABILITIES)
  mocks.getRuntimeEnvironmentStatus.mockResolvedValue({ capabilities: CHAT_CAPABILITIES })
}

const SSH_TARGET_ID = 'ssh-target-1'
const SSH_REPO_ID = 'repo-ssh'
const SSH_HOST_KEY = hostStableKey({
  authority: { kind: 'desktop' },
  selector: { kind: 'ssh', targetId: SSH_TARGET_ID }
})

const DESKTOP_SELF_KEY = hostStableKey({
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
})
const RUNTIME_SELF_KEY = hostStableKey({
  authority: { kind: 'runtime', environmentId: RUNTIME_ID },
  selector: { kind: 'self' }
})

/** A desktop-registered SSH host, with the generation that makes it fenceable. */
function addSshHost(): void {
  mocks.state.sshTargetLabels = new Map([[SSH_TARGET_ID, 'openclaw']])
  mocks.state.sshTargetGenerations = new Map([[SSH_TARGET_ID, 1]])
  mocks.state.sshConnectionStates = new Map([[SSH_TARGET_ID, { status: 'connected' }]])
}

/** A project checked out on that SSH host rather than locally. */
function addSshProject(): void {
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

/** A runtime project with the same host-local id as the desktop project. */
function addCollidingRuntimeProject(): void {
  const repo: Repo = {
    id: REPO_ID,
    displayName: 'orca on m4-air',
    path: '/repos/orca',
    badgeColor: '#111111',
    addedAt: 1,
    worktreeBaseRef: 'main',
    executionHostId: `runtime:${RUNTIME_ID}`
  }
  mocks.state.repos = [...(mocks.state.repos as Repo[]), repo]
  mocks.state.projectHostSetups = [
    ...mocks.state.projectHostSetups,
    {
      id: 'setup-runtime-collision',
      projectId: 'project-runtime-collision',
      hostId: `runtime:${RUNTIME_ID}`,
      repoId: REPO_ID,
      path: '/repos/orca',
      displayName: 'orca on m4-air',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }
  ]
}

/** The runtime answers a create; without this the RPC double returns an empty result. */
function runtimeCreateReturns(automation: Automation): void {
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

async function openCreateDialogFor(projectId: string, workspaceId: string): Promise<void> {
  await act(async () => {
    mocks.listPanel?.openCreateDialog()
  })
  await act(async () => {
    mocks.editorDialog?.onDraftChange((current) => ({
      ...(current as Record<string, unknown>),
      name: 'Sweep',
      prompt: 'Do the sweep',
      projectId,
      workspaceMode: 'existing',
      workspaceId
    }))
  })
}

async function save(): Promise<void> {
  await act(async () => {
    mocks.editorDialog?.onSave()
  })
}

function createRpcCalls(): unknown[][] {
  return mocks.callRuntimeRpc.mock.calls.filter((call) => call[1] === 'automation.create')
}

describe('AutomationsPage create destination', () => {
  it.each(['default-off', 'explicit'] as const)(
    'creates %s Terminal on the selected runtime while Chat observation is unavailable',
    async (selection) => {
      api.automations.list.mockResolvedValue([])
      scopedList([])
      runtimeHost([], [])
      runtimeCreateReturns(makeAutomation({ id: 'a-new', name: 'Sweep' }))
      mocks.state.runtimeStatusByEnvironmentId = new Map()
      addRuntimeProject()
      if (selection === 'explicit') {
        mocks.state.settings = { ...getDefaultSettings('/tmp'), experimentalNativeChat: true }
      }
      mocks.state.automationHostFilter = RUNTIME_SELF_FILTER

      await renderPage()
      await settleHostQueries()
      await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
      if (selection === 'explicit') {
        await act(async () => {
          mocks.editorDialog?.onDraftChange((current) => ({
            ...draftRecord(current),
            surface: 'terminal'
          }))
        })
      }
      await save()

      // Send the runtime’s own repo ID to its authority; the desktop is always the client authority, not the selected host.
      expect(api.automations.create).not.toHaveBeenCalled()
      expect(createRpcCalls()).toHaveLength(1)
      expect(createRpcCalls()[0]?.[0]).toEqual({ kind: 'environment', environmentId: RUNTIME_ID })
      expect(createRpcCalls()[0]?.[2]).not.toHaveProperty('launchSetupPatch')
      expect(createRpcCalls()[0]?.[3]).toMatchObject({ expectedEnvironmentPairingRevision: 4 })
      expect(createRpcCalls()[0]?.[2]).toMatchObject({
        repo: `id:${RUNTIME_REPO_ID}`,
        workspace: `id:${RUNTIME_WORKSPACE_ID}`,
        destination: { selector: { kind: 'self' } }
      })
    }
  )

  it.each([true, false])(
    'retains native intent through unknown support, then saves the known %s outcome',
    async (supported) => {
      api.automations.list.mockResolvedValue([])
      scopedList([])
      runtimeHost([], [])
      addRuntimeProject()
      mocks.state.settings = { ...getDefaultSettings('/tmp'), experimentalNativeChat: true }
      mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
      runtimeCreateReturns(makeAutomation({ id: 'a-new' }))
      observeRuntimeChat(null)
      const page = await renderPage()
      await settleHostQueries()
      await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...draftRecord(current),
          extraAgentArgs: '--model opus',
          reuseSession: false
        }))
      })
      await save()
      expect(createRpcCalls()).toHaveLength(0)
      expect(api.automations.create).not.toHaveBeenCalled()
      expect(mocks.editorDialog?.open).toBe(true)
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...draftRecord(current),
          surface: 'chat'
        }))
      })
      await save()
      expect(createRpcCalls()).toHaveLength(0)
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...draftRecord(current),
          surface: undefined
        }))
      })

      capableChatDestination()
      if (!supported) {
        observeRuntimeChat(
          CHAT_CAPABILITIES.filter(
            (capability) => capability !== STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
          )
        )
      }
      await page.rerender()
      await save()
      expect(mocks.toastError.mock.calls).toEqual([])
      expect(mocks.editorDialog?.notice).toBeFalsy()
      expect(createRpcCalls()).toHaveLength(1)
      if (supported) {
        expect(createRpcCalls()[0]?.[2]).toMatchObject({
          launchSetupPatch: {
            surface: 'chat',
            arguments: { kind: 'legacy-extras', value: '--model opus' }
          }
        })
      } else {
        expect(createRpcCalls()[0]?.[2]).not.toHaveProperty('launchSetupPatch')
        expect(createRpcCalls()[0]?.[2]).toMatchObject({ extraAgentArgs: '--model opus' })
      }
    }
  )

  it('retains admitted native Chat when support becomes unknown during the actual hook await', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    addRuntimeProject()
    capableChatDestination()
    mocks.state.settings = { ...getDefaultSettings('/tmp'), experimentalNativeChat: true }
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
    runtimeCreateReturns(makeAutomation({ id: 'a-new', surface: 'chat' }))
    const { checkRuntimeHooks } = await import('@/runtime/runtime-hooks-client')
    const held = Promise.withResolvers<HookCheckResult>()
    vi.mocked(checkRuntimeHooks).mockReturnValue(held.promise)
    try {
      const page = await renderPage()
      await settleHostQueries()
      await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...draftRecord(current),
          workspaceMode: 'new_per_run',
          workspaceId: '',
          extraAgentArgs: '--model opus'
        }))
      })
      await save()
      expect(checkRuntimeHooks).toHaveBeenCalledWith(`runtime:${RUNTIME_ID}`, RUNTIME_REPO_ID)
      expect(createRpcCalls()).toHaveLength(0)
      observeRuntimeChat(null)
      await page.rerender()
      await act(async () => {
        held.resolve({ status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false })
      })
      await settleHostQueries()
      expect(createRpcCalls()).toHaveLength(1)
      expect(createRpcCalls()[0]?.[2]).toMatchObject({
        launchSetupPatch: {
          surface: 'chat',
          arguments: { kind: 'legacy-extras', value: '--model opus' }
        }
      })
    } finally {
      held.resolve({ status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false })
      vi.mocked(checkRuntimeHooks).mockResolvedValue({
        status: 'ok',
        hasHooks: false,
        hooks: null,
        mayNeedUpdate: false
      })
    }
  })

  it('refuses a desktop project for a runtime destination instead of sending its id', async () => {
    // Reject desktop repo IDs before sending them to a runtime that cannot resolve them (repo_not_found).
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    runtimeCreateReturns(makeAutomation({ id: 'a-new', name: 'Sweep' }))
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(REPO_ID, WORKSPACE_ID)
    await save()

    expect(api.automations.create).not.toHaveBeenCalled()
    expect(createRpcCalls()).toHaveLength(0)
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.open).toBe(true)
  })

  it('refuses a runtime-owned project under the desktop destination', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addRuntimeProject()
    mocks.state.runtimeStatusByEnvironmentId = new Map([
      [RUNTIME_ID, { status: { capabilities: [] } }]
    ])

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
    await save()

    // A missing connection ID does not prove desktop ownership; this project belongs to the runtime.
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.open).toBe(true)
  })

  it('requires an explicit host choice when All hosts spans more than one host', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    runtimeCreateReturns(makeAutomation({ id: 'a-new', name: 'Sweep' }))
    addRuntimeProject()

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(REPO_ID, WORKSPACE_ID)
    await save()

    expect(api.automations.create).not.toHaveBeenCalled()
    expect(createRpcCalls()).toHaveLength(0)
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.createDestination?.entries.map((entry) => entry.stableKey)).toEqual(
      expect.arrayContaining([DESKTOP_SELF_KEY, RUNTIME_SELF_KEY])
    )

    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(RUNTIME_SELF_KEY)
    })
    expect(mocks.editorDialog?.createDestination?.resolution.status).toBe('ready')
    // The stated host stranded the desktop project; the draft moves to its own.
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        projectId: RUNTIME_REPO_ID,
        workspaceId: RUNTIME_WORKSPACE_ID
      }))
    })
    await save()

    expect(createRpcCalls()).toHaveLength(1)
    expect(api.automations.create).not.toHaveBeenCalled()
  })

  it('offers only the projects the chosen host actually has', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addSshHost()
    addSshProject()

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openCreateDialog()
    })
    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(SSH_HOST_KEY)
    })

    // Same-name local/SSH projects are ambiguous unless the picker is scoped to the destination.
    expect(mocks.editorDialog?.repos?.map((repo) => repo.id)).toEqual([SSH_REPO_ID])
  })

  it('moves a stranded project to one the newly chosen host has', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addSshHost()
    addSshProject()

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(REPO_ID, WORKSPACE_ID)
    expect(mocks.editorDialog?.draft?.projectId).toBe(REPO_ID)

    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(SSH_HOST_KEY)
    })

    // Keeping the local project selected only defers the same refusal to submit.
    expect(mocks.editorDialog?.draft?.projectId).toBe(SSH_REPO_ID)
  })

  it('offers nothing rather than a stranded project when the host has no projects', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addSshHost()

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openCreateDialog()
    })
    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(SSH_HOST_KEY)
    })

    expect(mocks.editorDialog?.repos).toEqual([])
    // Nothing is left selected to submit against a host that cannot hold it.
    expect(mocks.editorDialog?.draft?.projectId).toBe('')
  })

  it('states the chosen host on the form before submit', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(REPO_ID, WORKSPACE_ID)
    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(RUNTIME_SELF_KEY)
    })

    const resolution = mocks.editorDialog?.createDestination?.resolution
    // The owner shown is the storage authority, not the workspace's run host.
    expect(resolution?.status === 'ready' && resolution.entry.stableKey).toBe(RUNTIME_SELF_KEY)
    expect(resolution?.status === 'ready' && resolution.authority).toEqual({
      kind: 'runtime',
      environmentId: RUNTIME_ID,
      pairingRevision: 4
    })
  })

  it('fails closed when the destination host changes incarnation while the form is open', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    runtimeCreateReturns(makeAutomation({ id: 'a-new', name: 'Sweep' }))
    addRuntimeProject()
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER

    const { rerender } = await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)

    // The host re-paired while the form was open: same stable key, new owner.
    mocks.state.runtimeEnvironments = [
      { id: RUNTIME_ID, name: 'GPU box', createdAt: 1, pairingRevision: 9 }
    ]
    await rerender()
    await save()

    expect(createRpcCalls()).toHaveLength(0)
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.open).toBe(true)
  })
})

describe('AutomationsPage edit fencing', () => {
  async function editAndSave(row: AutomationListRow): Promise<void> {
    await act(async () => {
      void mocks.listPanel?.openEditDialog(row)
    })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        name: 'Renamed'
      }))
    })
    await save()
  }

  function updatePreconditions(): unknown[] {
    return api.automations.update.mock.calls.map(
      ([payload]) => (payload as { expectedOwner?: unknown }).expectedOwner
    )
  }

  it('fences the save even when the record cannot be re-read', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    mocks.state.settings = { ...getDefaultSettings('/tmp'), experimentalNativeChat: true }
    const { setLocalRuntimeCapabilitiesForTests } =
      await import('@/runtime/local-runtime-capabilities')
    setLocalRuntimeCapabilitiesForTests(null)
    api.automations.list.mockResolvedValue([])
    scopedList([automation])

    await renderPage()
    await settleHostQueries()
    // The row is gone from its host by the time the form is saved.
    scopedList([])
    await editAndSave(listedRow(automation.id))

    expect(api.automations.update).toHaveBeenCalled()
    expect(updatePreconditions()).not.toContain(undefined)
    expect(api.automations.update.mock.calls[0]?.[0]).toMatchObject({
      updates: { name: 'Renamed' }
    })
    expect(api.automations.update.mock.calls[0]?.[0]?.updates).not.toHaveProperty(
      'launchSetupPatch'
    )
  })

  it('refuses the save when nothing names the record’s host', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    // No host answered, so no owner was captured; the legacy-addressable record is also gone.
    api.automations.listScoped.mockRejectedValue(new Error('offline'))
    api.automations.list.mockResolvedValue([])

    await renderPage()
    await settleHostQueries()
    // Only the pre-catalog projection could have supplied the clicked key before any host answered.
    await editAndSave(unscopedAutomationListRows([automation])[0]!)

    expect(api.automations.update).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
  })
})

describe('AutomationsPage edit dialog projects', () => {
  it('offers the edited row’s own host projects, not the create destination’s', async () => {
    const automation = makeAutomation({
      id: 'a-runtime',
      projectId: RUNTIME_REPO_ID,
      workspaceId: RUNTIME_WORKSPACE_ID
    })
    // The ambient desktop list never held this row; only its captured owner can locate it.
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([automation], [])
    addRuntimeProject()

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })

    expect(mocks.editorDialog?.isEditing).toBe(true)
    expect(mocks.editorDialog?.repos?.map((repo) => repo.id)).toEqual([RUNTIME_REPO_ID])
  })
})

describe('AutomationsPage edit destination', () => {
  it('names the edited row’s own host, and offers every host it could move to', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])
    addSshHost()
    addSshProject()
    runtimeHost([], [])

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })

    const resolution = mocks.editorDialog?.editDestination?.resolution
    expect(resolution?.status === 'ready' && resolution.entry.stableKey).toBe(DESKTOP_SELF_KEY)
    // Cross-authority moves create at the destination then delete at the source; keep both legal destinations offered.
    expect(mocks.editorDialog?.editDestination?.entries.map((entry) => entry.stableKey)).toContain(
      RUNTIME_SELF_KEY
    )
    expect(mocks.editorDialog?.editDestination?.moveWarning).toBeFalsy()
  })

  it.each(['legacy', 'chat'] as const)(
    'moves the saved %s record across authorities by creating there and deleting here',
    async (surface) => {
      const automation = makeAutomation({
        id: 'a-1',
        ...(surface === 'chat' ? { surface, extraAgentArgs: '--model opus' } : {})
      })
      api.automations.list.mockResolvedValue([])
      scopedList([automation])
      runtimeHost([], [])
      addRuntimeProject()
      if (surface === 'chat') {
        capableChatDestination()
      }
      const removed = Promise.withResolvers<void>()
      api.automations.delete.mockReturnValueOnce(removed.promise)
      runtimeCreateReturns(
        makeAutomation({
          id: 'a-moved',
          projectId: RUNTIME_REPO_ID,
          ...(surface === 'chat' ? { surface, extraAgentArgs: '--model opus' } : {})
        })
      )

      await renderPage()
      await settleHostQueries()
      await act(async () => {
        void mocks.listPanel?.openEditDialog(listedRow(automation.id))
      })
      await act(async () => {
        mocks.editorDialog?.editDestination?.onSelect(RUNTIME_SELF_KEY)
      })

      expect(mocks.editorDialog?.editDestination?.moveWarning).toBeTruthy()

      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...(current as Record<string, unknown>),
          projectId: RUNTIME_REPO_ID,
          workspaceMode: 'existing',
          workspaceId: RUNTIME_WORKSPACE_ID
        }))
      })
      await save()

      expect(api.automations.update).not.toHaveBeenCalled()
      expect(createRpcCalls()).toHaveLength(1)
      expect(createRpcCalls()[0]?.[2]).toMatchObject({
        repo: `id:${RUNTIME_REPO_ID}`,
        dtstart: automation.dtstart
      })
      if (surface === 'chat') {
        expect(createRpcCalls()[0]?.[2]).toMatchObject({
          launchSetupPatch: {
            surface: 'chat',
            arguments: { kind: 'legacy-extras', value: '--model opus' }
          }
        })
      }
      expect(api.automations.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-1' }))
      const createIndex = mocks.callRuntimeRpc.mock.calls.findIndex(
        (call) => call[1] === 'automation.create'
      )
      expect(mocks.callRuntimeRpc.mock.invocationCallOrder[createIndex]).toBeLessThan(
        api.automations.delete.mock.invocationCallOrder[0]
      )
      expect(mocks.toastSuccess).not.toHaveBeenCalled()
      await act(async () => {
        removed.resolve()
      })
      await settleHostQueries()
      expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('moved'))
    }
  )

  it.each(['old', 'unknown', 'refused'] as const)(
    'preserves the saved Chat source when destination creation is %s',
    async (outcome) => {
      const automation = makeAutomation({
        id: 'a-1',
        surface: 'chat',
        extraAgentArgs: '--model opus'
      })
      api.automations.list.mockResolvedValue([])
      scopedList([automation])
      runtimeHost([], [])
      addRuntimeProject()
      capableChatDestination()
      runtimeCreateReturns(makeAutomation({ id: 'a-moved', surface: 'chat' }))
      await renderPage()
      await settleHostQueries()
      await act(async () => {
        void mocks.listPanel?.openEditDialog(listedRow(automation.id))
      })
      await act(async () => {
        mocks.editorDialog?.editDestination?.onSelect(RUNTIME_SELF_KEY)
      })
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => ({
          ...draftRecord(current),
          projectId: RUNTIME_REPO_ID,
          workspaceMode: 'existing',
          workspaceId: RUNTIME_WORKSPACE_ID
        }))
      })
      const { resetAutomationCapabilityProbes } = await import('./automation-scoped-list-client')
      resetAutomationCapabilityProbes()
      mocks.getRuntimeEnvironmentStatus.mockClear()
      if (outcome === 'old') {
        mocks.getRuntimeEnvironmentStatus.mockResolvedValue({
          capabilities: CHAT_CAPABILITIES.filter(
            (capability) => capability !== AUTOMATION_SURFACE_RUNTIME_CAPABILITY
          )
        })
      } else if (outcome === 'unknown') {
        mocks.getRuntimeEnvironmentStatus.mockRejectedValue(new Error('capabilities unavailable'))
      } else {
        const previous = mocks.callRuntimeRpc.getMockImplementation()
        mocks.callRuntimeRpc.mockImplementation(async (...args) => {
          if (args[1] === 'automation.create') {
            throw new Error('destination refused create')
          }
          return await previous?.(...args)
        })
      }
      await save()
      expect(mocks.getRuntimeEnvironmentStatus).toHaveBeenCalled()
      expect(createRpcCalls()).toHaveLength(outcome === 'refused' ? 1 : 0)
      if (outcome === 'old') {
        expect(mocks.editorDialog?.notice?.message).toContain('run automations in Chat')
      }
      if (outcome === 'refused') {
        expect(createRpcCalls()[0]?.[2]).toMatchObject({ launchSetupPatch: { surface: 'chat' } })
      }
      expect(api.automations.delete).not.toHaveBeenCalled()
      expect(mocks.toastSuccess).not.toHaveBeenCalled()
      expect(mocks.editorDialog?.open).toBe(true)
      expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    }
  )

  it('moves when the destination project has the same host-local id', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])
    runtimeHost([], [])
    addCollidingRuntimeProject()
    runtimeCreateReturns(makeAutomation({ id: 'a-moved', projectId: REPO_ID }))

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    await act(async () => {
      mocks.editorDialog?.editDestination?.onSelect(RUNTIME_SELF_KEY)
    })
    await save()

    expect(createRpcCalls()).toHaveLength(1)
    expect(createRpcCalls()[0]?.[2]).toMatchObject({ repo: `id:${REPO_ID}` })
    expect(api.automations.delete).toHaveBeenCalled()
  })

  it('reuses the move creation key on retry even when the schedule changed', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])
    runtimeHost([], [])
    addRuntimeProject()
    // Transport may fail after create commits; retries need the identical creationKey to avoid duplicates.
    let failCreate = true
    const previous = mocks.callRuntimeRpc.getMockImplementation()
    mocks.callRuntimeRpc.mockImplementation(
      async (target: unknown, method: string, params: unknown, options: unknown) => {
        if (method === 'automation.create') {
          if (failCreate) {
            failCreate = false
            throw new Error('socket hang up')
          }
          return { automation: makeAutomation({ id: 'a-moved', projectId: RUNTIME_REPO_ID }) }
        }
        return await previous?.(target, method, params, options)
      }
    )

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    await act(async () => {
      mocks.editorDialog?.editDestination?.onSelect(RUNTIME_SELF_KEY)
    })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        projectId: RUNTIME_REPO_ID,
        workspaceMode: 'existing',
        workspaceId: RUNTIME_WORKSPACE_ID,
        // Changed schedules mint dtstart per attempt; this volatile field must not re-key a move.
        preset: 'custom',
        customSchedule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0'
      }))
    })

    const realNow = Date.now.bind(Date)
    let clockSkew = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockSkew)
    try {
      await save()
      clockSkew = 5000
      await save()
    } finally {
      nowSpy.mockRestore()
    }

    const creationKeys = createRpcCalls().map(
      (call) => (call[2] as { creationKey?: string }).creationKey
    )
    expect(creationKeys).toHaveLength(2)
    expect(creationKeys[0]).toBeTruthy()
    expect(creationKeys[1]).toBe(creationKeys[0])
    expect(api.automations.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-1' }))
  })

  it('reports a kept saved-Chat original as two live copies, never as a completed move', async () => {
    const automation = makeAutomation({
      id: 'a-1',
      surface: 'chat',
      extraAgentArgs: '--model opus'
    })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])
    runtimeHost([], [])
    addRuntimeProject()
    capableChatDestination()
    runtimeCreateReturns(
      makeAutomation({
        id: 'a-moved',
        projectId: RUNTIME_REPO_ID,
        surface: 'chat',
        extraAgentArgs: '--model opus'
      })
    )
    api.automations.delete.mockRejectedValue(new Error('gone away'))

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    await act(async () => {
      mocks.editorDialog?.editDestination?.onSelect(RUNTIME_SELF_KEY)
    })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        projectId: RUNTIME_REPO_ID,
        workspaceMode: 'existing',
        workspaceId: RUNTIME_WORKSPACE_ID
      }))
    })
    await save()

    expect(createRpcCalls()).toHaveLength(1)
    expect(createRpcCalls()[0]?.[2]).toMatchObject({
      launchSetupPatch: {
        surface: 'chat',
        arguments: { kind: 'legacy-extras', value: '--model opus' }
      }
    })
    expect(api.automations.delete).toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('could not be deleted'))
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('moves the record to the host the user picks, clearing the stranded project', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])
    addSshHost()
    addSshProject()

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    await act(async () => {
      mocks.editorDialog?.editDestination?.onSelect(SSH_HOST_KEY)
    })

    // Keeping the local project selected only defers the same refusal to submit.
    expect(mocks.editorDialog?.repos?.map((repo) => repo.id)).toEqual([SSH_REPO_ID])
    expect(mocks.editorDialog?.draft?.projectId).toBe('')

    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        projectId: SSH_REPO_ID,
        workspaceMode: 'new_per_run',
        workspaceId: ''
      }))
    })
    await save()

    expect(api.automations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: { selector: { kind: 'ssh', targetId: SSH_TARGET_ID, targetGeneration: 1 } }
      })
    )
  })
})

describe('AutomationsPage create admission', () => {
  it('keeps the create button available while every offered host is ineligible', async () => {
    // Keep Create available to open the dialog that explains repairs, even before any host is eligible.
    api.automations.listScoped.mockRejectedValue(new Error('offline'))
    api.automations.list.mockResolvedValue([])

    await renderPage()
    await settleHostQueries()

    expect(mocks.listPanel?.canCreateAutomation).toBe(true)
  })

  it('refuses a mismatched create destination before the hooks trust prompt', async () => {
    // Refuse the mismatched destination before asking the user to trust setup hooks.
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addRuntimeProject()
    // A default-run hook would have prompted for trust under the old save order.
    const { checkRuntimeHooks } = await import('@/runtime/runtime-hooks-client')
    vi.mocked(checkRuntimeHooks).mockResolvedValue({
      status: 'ok',
      hooks: { scripts: { setup: 'pnpm install' } }
    } as never)

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openCreateDialog()
    })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        name: 'Sweep',
        prompt: 'Do the sweep',
        projectId: RUNTIME_REPO_ID,
        workspaceMode: 'new_per_run',
        workspaceId: ''
      }))
    })
    await save()

    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    const { ensureHooksConfirmed } = await import('@/lib/ensure-hooks-confirmed')
    expect(vi.mocked(ensureHooksConfirmed)).not.toHaveBeenCalled()
    expect(api.automations.create).not.toHaveBeenCalled()
  })
})
