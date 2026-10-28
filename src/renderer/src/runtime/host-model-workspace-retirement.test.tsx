// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { mergeFetchedWorktrees } from '@/store/slices/worktrees/listing/fetched-worktree-merge'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { createTestStore, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { useStructuredAgentSessionOptions } from '@/components/native-chat/use-structured-agent-session-options'
import {
  forgetHostModelCatalogSnapshots,
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from './host-model-catalog-snapshots'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { createCompatibleRuntimeStatusResponseIfNeeded } from './runtime-compatibility-test-fixture'
import { resetStructuredAgentSessionStatusFeedsForTests } from './structured-agent-session-status-feed'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const calls = vi.hoisted(() => ({ catalog: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() }
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: (...args: unknown[]) => calls.catalog(...args),
  subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} })
}))
vi.mock('@/components/native-chat/native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(async () => ({ kind: 'held' })),
  getStructuredAgentSessionLaunchSelection: () => null
}))
const HOST = 'runtime:catalog-host'
const target = { kind: 'environment', environmentId: 'catalog-host' } as const
const mutate = vi.fn(async () => null)
let sequence = 0
beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  resetHostModelCatalogSnapshotsForTests()
  sequence = 0
  calls.catalog.mockReset().mockImplementation((_target, method) => {
    if (method !== 'agentSession.modelCatalog') {
      return new Promise(() => {})
    }
    sequence++
    return Promise.resolve({
      origin: 'probe',
      fetchedAt: sequence,
      modelsDifferByWorkspace: true,
      models: ['grok-build', 'grok-mini', 'grok-chat'].map((id, index) => ({
        id,
        label: id,
        isDefault: index === 0,
        efforts: []
      }))
    })
  })
  const api = createStoreCascadesMockApi()
  api.runtimeEnvironments.call.mockImplementation((args) =>
    Promise.resolve(
      createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
        id: 'catalog-rpc',
        ok: true,
        result:
          args.method === 'folderWorkspace.delete' || args.method === 'projectGroup.delete'
            ? { deleted: true }
            : { removed: true },
        _meta: { runtimeId: 'catalog-runtime' }
      }
    )
  )
  Object.assign(window, {
    api: {
      ...api,
      repos: { ...api.repos, removeForHost: vi.fn(async () => undefined) },
      ephemeralVm: { listRuntimes: vi.fn(async () => []) }
    }
  })
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
  resetHostModelCatalogSnapshotsForTests()
  vi.restoreAllMocks()
})

function renderChat(worktreeId: string, hostTarget: RuntimeClientTarget = target) {
  return renderHook(() =>
    useStructuredAgentSessionOptions({
      agent: 'codex',
      sessionId: `session-${worktreeId}`,
      target: hostTarget,
      transportEnabled: false,
      isVisible: true,
      providerVisible: false,
      fence: null,
      turnId: null,
      unloadedTurnRevisions: undefined,
      mutate,
      launch: { kind: 'new', heldOptions: {}, worktree: toRuntimeWorktreeSelector(worktreeId) }
    })
  )
}
async function openChat(worktreeId: string, hostTarget: RuntimeClientTarget = target) {
  const hook = renderChat(worktreeId, hostTarget)
  await act(async () => {})
  hook.unmount()
}
function read(worktreeId: string, hostTarget: RuntimeClientTarget = target) {
  return readHostModelCatalogSnapshot(hostTarget, 'codex', {
    newLaunch: true,
    worktree: toRuntimeWorktreeSelector(worktreeId),
    seedsModel: false
  })
}
it.each([10, 100])('counts retained catalogs after %i actual workspace removals', async (count) => {
  const store = createTestStore()
  const worktrees = Array.from({ length: count }, (_, index) =>
    makeWorktree({
      id: `${TEST_REPO.id}::/workspace/model-retention-${count}-${index}`,
      repoId: TEST_REPO.id,
      hostId: HOST
    })
  )
  const survivor = makeWorktree({
    id: `${TEST_REPO.id}::/survivor`,
    repoId: TEST_REPO.id,
    hostId: HOST
  })
  store.setState({
    repos: [{ ...TEST_REPO, executionHostId: HOST }],
    worktreesByRepo: { [TEST_REPO.id]: [...worktrees, survivor] }
  })
  await openChat(survivor.id)
  for (const worktree of worktrees) {
    await openChat(worktree.id)
  }
  expect(sequence).toBe(count + 1)
  for (const worktree of worktrees) {
    expect(
      await store.getState().removeWorktree({ id: worktree.id, executionHostId: HOST }, false)
    ).toEqual({ ok: true })
  }
  expect(store.getState().worktreesByRepo[TEST_REPO.id].map((row) => row.id)).toEqual([survivor.id])
  const retired = worktrees.map((row) => read(row.id)).filter((value) => value !== undefined)
  expect(retired).toHaveLength(0)
  expect(read(survivor.id)).toBeDefined()
})

function workspaceStore(id: string) {
  const store = createTestStore()
  store.setState({
    repos: [{ ...TEST_REPO, executionHostId: HOST }],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id, repoId: TEST_REPO.id, hostId: HOST })]
    }
  })
  return store
}
function catalog(fetchedAt: number): AgentSessionModelCatalogResult {
  return {
    origin: 'probe',
    fetchedAt,
    modelsDifferByWorkspace: true,
    models: [{ id: 'grok-build', label: 'Grok Build', isDefault: true, efforts: [] }]
  }
}

it.each(['failed', 'cancelled'] as const)(
  'keeps the catalog when deletion is %s',
  async (outcome) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const id = 'repo1::/failed-catalog'
    const store = workspaceStore(id)
    await openChat(id)
    const before = read(id)
    if (outcome === 'failed') {
      window.api.runtimeEnvironments.call = vi.fn(async () => {
        throw new Error('failed')
      })
    }
    const result = await store.getState().removeWorktree(
      { id, executionHostId: HOST },
      false,
      outcome === 'cancelled'
        ? {
            assertBeforeDispatch: () => {
              throw new Error('cancelled')
            }
          }
        : {}
    )
    expect(result.ok).toBe(false)
    expect(read(id)).toBe(before)
  }
)

it('preserves another host with the same workspace id', async () => {
  const id = 'repo1::/catalog-twin'
  const store = workspaceStore(id)
  const local = { kind: 'local' } as const
  store.setState({
    repos: [{ ...TEST_REPO, executionHostId: 'local' }],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id, repoId: TEST_REPO.id, hostId: 'local' })]
    }
  })
  const other = { kind: 'environment', environmentId: 'other-host' } as const
  store.setState((state) => ({
    repos: [...state.repos, { ...TEST_REPO, executionHostId: 'runtime:other-host' }],
    worktreesByRepo: {
      [TEST_REPO.id]: [
        ...state.worktreesByRepo[TEST_REPO.id],
        makeWorktree({ id, repoId: TEST_REPO.id, hostId: 'runtime:other-host' })
      ]
    }
  }))
  await openChat(id, local)
  await openChat(id, other)
  const survivor = read(id, other)
  expect(await store.getState().removeWorktree({ id, executionHostId: 'local' }, false)).toEqual({
    ok: true
  })
  expect(read(id, local)).toBeUndefined()
  expect(read(id, other)).toBe(survivor)
})

it('keeps the account default and another workspace configuration', async () => {
  const id = 'repo1::/catalog-default'
  const store = workspaceStore(id)
  const account: AgentSessionModelCatalogResult = {
    origin: 'probe',
    fetchedAt: 0,
    defaultHoldsInEveryWorkspace: true,
    models: [{ id: 'account', label: 'Account', isDefault: true, efforts: [] }]
  }
  recordHostModelCatalogSnapshot(target, 'codex', null, account)
  await openChat(id)
  await openChat('repo1::/catalog-survivor')
  const survivor = read('repo1::/catalog-survivor')
  expect(await store.getState().removeWorktree({ id, executionHostId: HOST }, false)).toEqual({
    ok: true
  })
  expect(read(id)).toBe(account)
  expect(read('repo1::/catalog-survivor')).toBe(survivor)
})

it.each(['deleted', 'rejected', 'failed'] as const)(
  'retires only successfully %s folder catalogs',
  async (outcome) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createTestStore()
    const folder = { ...makeFolderWorkspace(), executionHostId: HOST }
    store.setState({ folderWorkspaces: [folder] })
    const id = `folder:${folder.id}`
    await openChat(id)
    const before = read(id)
    if (outcome !== 'deleted') {
      window.api.runtimeEnvironments.call = vi.fn(
        async (args) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ??
          (outcome === 'failed'
            ? await Promise.reject(new Error('failed'))
            : {
                id: 'rpc',
                ok: true,
                result: { deleted: false },
                _meta: { runtimeId: 'catalog-runtime' }
              })
      )
    }
    expect(await store.getState().deleteFolderWorkspace(folder.id)).toBe(outcome === 'deleted')
    expect(read(id)).toBe(outcome === 'deleted' ? undefined : before)
  }
)

it.each([false, true])('fences a late reply after removal, recreation=%s', async (recreate) => {
  const id = 'repo1::/catalog-recreated'
  const store = workspaceStore(id)
  const oldReply = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const replacementReply = Promise.withResolvers<AgentSessionModelCatalogResult>()
  let reads = 0
  calls.catalog.mockImplementation((_target, method) => {
    if (method !== 'agentSession.modelCatalog') {
      return new Promise(() => {})
    }
    reads++
    return reads === 1 ? oldReply.promise : replacementReply.promise
  })
  renderChat(id)
  await act(async () => {})
  expect(reads).toBe(1)
  expect(await store.getState().removeWorktree({ id, executionHostId: HOST }, false)).toEqual({
    ok: true
  })
  if (recreate) {
    store.setState({
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id, repoId: TEST_REPO.id, hostId: HOST })]
      }
    })
    renderChat(id)
    await act(async () => {})
    expect(reads).toBe(2)
    await act(async () => replacementReply.resolve(catalog(2)))
  }
  await act(async () => oldReply.resolve(catalog(1)))
  expect(read(id)).toEqual(recreate ? catalog(2) : undefined)
})

it('retires catalogs for a successfully removed project', async () => {
  const id = 'repo1::/catalog-project'
  const store = workspaceStore(id)
  await openChat(id)
  await store.getState().removeProject(TEST_REPO.id, { hostId: HOST })
  expect(store.getState().repos).toEqual([])
  expect(read(id)).toBeUndefined()
})

function group(id: string, parentGroupId: string | null = null): ProjectGroup {
  return {
    id,
    parentGroupId,
    executionHostId: HOST,
    name: id,
    parentPath: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

it.each([true, false])('retires a deleted group subtree only after success=%s', async (deleted) => {
  const store = createTestStore()
  const parent = group('group-parent')
  const child = group('group-child', parent.id)
  const folders = [
    makeFolderWorkspace({ id: 'parent-folder', projectGroupId: parent.id, executionHostId: HOST }),
    makeFolderWorkspace({ id: 'child-folder', projectGroupId: child.id, executionHostId: HOST }),
    makeFolderWorkspace({
      id: 'survivor-folder',
      projectGroupId: 'survivor-group',
      executionHostId: HOST
    })
  ]
  const other = { kind: 'environment', environmentId: 'other-host' } as const
  const twin = { ...folders[0], executionHostId: 'runtime:other-host' }
  store.setState({
    projectGroups: [
      parent,
      child,
      group('survivor-group'),
      { ...parent, executionHostId: 'runtime:other-host' }
    ],
    folderWorkspaces: [...folders, twin]
  })
  for (const folder of folders) {
    await openChat(`folder:${folder.id}`)
  }
  await openChat(`folder:${twin.id}`, other)
  const before = folders.map((folder) => read(`folder:${folder.id}`))
  const twinCatalog = read(`folder:${twin.id}`, other)
  if (!deleted) {
    vi.mocked(window.api.runtimeEnvironments.call).mockImplementation(
      async (args) =>
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc',
          ok: true,
          result: { deleted: false },
          _meta: { runtimeId: 'catalog-runtime' }
        }
    )
  }
  expect(await store.getState().deleteProjectGroup(parent.id, { hostId: HOST })).toBe(deleted)
  for (const [index, folder] of folders.entries()) {
    expect(read(`folder:${folder.id}`)).toBe(deleted && index < 2 ? undefined : before[index])
  }
  expect(read(`folder:${twin.id}`, other)).toBe(twinCatalog)
})

it.each(['removed', 'present', 'failed'] as const)(
  'reconciles folder catalog when workspace is %s',
  async (outcome) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createTestStore()
    const folder = makeFolderWorkspace({ executionHostId: HOST })
    const other = { kind: 'environment', environmentId: 'other-host' } as const
    const twin = { ...folder, executionHostId: 'runtime:other-host' }
    store.setState({ folderWorkspaces: [folder, twin] })
    const id = `folder:${folder.id}`
    await openChat(id)
    await openChat(id, other)
    const before = read(id)
    const twinCatalog = read(id, other)
    vi.mocked(window.api.runtimeEnvironments.call).mockImplementation(async (args) => {
      const status = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (status) {
        return status
      }
      if (outcome === 'failed') {
        throw new Error('offline')
      }
      return {
        id: 'rpc',
        ok: true,
        result: { folderWorkspaces: outcome === 'present' ? [{ ...folder, name: 'Updated' }] : [] },
        _meta: { runtimeId: 'catalog-runtime' }
      }
    })
    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: target.environmentId })
    expect(read(id)).toBe(outcome === 'removed' ? undefined : before)
    expect(read(id, other)).toBe(twinCatalog)
  }
)

it.each(['removed', 'present', 'partial', 'fallback'] as const)(
  'reconciles a worktree catalog when workspace is %s',
  async (outcome) => {
    const id = 'repo1::/catalog-listing'
    const store = workspaceStore(id)
    const survivor = makeWorktree({
      id: 'repo1::/catalog-listing-survivor',
      repoId: TEST_REPO.id,
      hostId: HOST
    })
    const rows = [...store.getState().worktreesByRepo[TEST_REPO.id], survivor]
    store.setState({ worktreesByRepo: { [TEST_REPO.id]: rows } })
    await openChat(id)
    await openChat(survivor.id)
    const before = read(id)
    const survivorCatalog = read(survivor.id)
    const incoming = outcome === 'present' ? rows : [survivor]
    expect(
      mergeFetchedWorktrees(store.setState, store.getState, {
        repoId: TEST_REPO.id,
        hostId: HOST,
        ownerWasMissingAtStart: false,
        requestStartedWorktrees: rows,
        refresh: {
          status: 'admitted',
          executionHostId: HOST,
          result: {
            repoId: TEST_REPO.id,
            authoritative: outcome !== 'partial',
            source: outcome === 'fallback' ? 'session-fallback' : 'git',
            worktrees: incoming.map((row) => ({
              ...row,
              ownership: 'orca-managed',
              selectedCheckout: false,
              visible: true
            }))
          }
        }
      })
    ).toBe('applied')
    expect(read(id)).toBe(outcome === 'removed' ? undefined : before)
    expect(read(survivor.id)).toBe(survivorCatalog)
  }
)

it.each(['removed', 'present', 'failed'] as const)(
  'reconciles a failed folder update when workspace is %s',
  async (outcome) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createTestStore()
    const folder = makeFolderWorkspace({ executionHostId: HOST })
    const other = { kind: 'environment', environmentId: 'other-host' } as const
    store.setState({
      folderWorkspaces: [folder, { ...folder, executionHostId: 'runtime:other-host' }]
    })
    const id = `folder:${folder.id}`
    await openChat(id)
    await openChat(id, other)
    const before = read(id)
    const twin = read(id, other)
    vi.mocked(window.api.runtimeEnvironments.call).mockImplementation(async (args) => {
      const status = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (status) {
        return status
      }
      if (args.method === 'folderWorkspace.update') {
        return {
          id: 'rpc',
          ok: true,
          result: { folderWorkspace: null },
          _meta: { runtimeId: 'catalog-runtime' }
        }
      }
      if (outcome === 'failed') {
        throw new Error('offline')
      }
      return {
        id: 'rpc',
        ok: true,
        result: { folderWorkspaces: outcome === 'present' ? [folder] : [] },
        _meta: { runtimeId: 'catalog-runtime' }
      }
    })
    expect(
      await store
        .getState()
        .updateFolderWorkspace(folder.id, { name: 'renamed' }, { executionHostId: HOST })
    ).toBe(false)
    expect(read(id)).toBe(outcome === 'removed' ? undefined : before)
    expect(read(id, other)).toBe(twin)
  }
)

it('keeps a workspace-independent host default after its source workspace is removed', async () => {
  const id = 'repo1::/universal-catalog'
  const store = workspaceStore(id)
  const hostDefault = {
    ...catalog(1),
    modelsDifferByWorkspace: false,
    defaultHoldsInEveryWorkspace: true
  }
  calls.catalog.mockResolvedValue(hostDefault)
  await openChat(id)
  expect(read(id)).toBe(hostDefault)
  expect(await store.getState().removeWorktree({ id, executionHostId: HOST }, false)).toEqual({
    ok: true
  })
  expect(read('repo1::/another-workspace')).toBe(hostDefault)
})

it.each([{ agents: undefined }, { agents: ['codex'] }])(
  'fences a reply after host invalidation agents=$agents',
  async ({ agents }) => {
    const id = 'repo1::/host-retired-catalog'
    const reply = Promise.withResolvers<AgentSessionModelCatalogResult>()
    calls.catalog.mockReturnValue(reply.promise)
    renderChat(id)
    await act(async () => {})
    forgetHostModelCatalogSnapshots(target, agents)
    await act(async () => reply.resolve(catalog(1)))
    expect(read(id)).toBeUndefined()
  }
)

it.each([{ agents: undefined }, { agents: ['codex'] }])(
  'keeps a same-id host replacement after invalidation agents=$agents',
  async ({ agents }) => {
    const id = 'repo1::/host-recreated-catalog'
    const oldReply = Promise.withResolvers<AgentSessionModelCatalogResult>()
    const newReply = Promise.withResolvers<AgentSessionModelCatalogResult>()
    calls.catalog.mockReturnValueOnce(oldReply.promise).mockReturnValueOnce(newReply.promise)
    renderChat(id)
    await act(async () => {})
    expect(calls.catalog).toHaveBeenCalledTimes(1)
    forgetHostModelCatalogSnapshots(target, agents)
    renderChat(id)
    await act(async () => {})
    expect(calls.catalog).toHaveBeenCalledTimes(2)
    await act(async () => newReply.resolve(catalog(2)))
    await act(async () => oldReply.resolve(catalog(1)))
    expect(read(id)).toEqual(catalog(2))
  }
)
