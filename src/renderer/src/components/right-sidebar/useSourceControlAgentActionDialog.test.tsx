import { resetRendererAppPlatformCacheForTests } from '@/lib/renderer-app-platform'
import type { Repo } from '../../../../shared/repo-types'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { clearHostAgentMenuSettingsForTests } from '../settings/use-host-agent-launch-preferences'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY as SURFACE } from '../../../../shared/agent-launch-runtime-capability'
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT
} from '../../../../shared/protocol-version'
import { useAppStore } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { SourceControlAgentActionDialog } from './SourceControlAgentActionDialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSourceControlAgentActionDialog } from './useSourceControlAgentActionDialog'

const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  clearHostAgentMenuSettingsForTests()
  useAppStore.setState(initialState, true)
  setLocalRuntimeCapabilitiesForTests(null)
})

function renderDialog(chat: boolean, capable = true, initialRecipe?: SourceControlActionRecipe) {
  const settings = { ...getDefaultSettings('/tmp/pr-3'), defaultTuiAgent: 'claude' as const }
  const launchPreferences = { agentId: 'codex' as const, model: 'chosen' }
  settings.sourceControlAi!.actions = { resolveConflicts: { agentId: null, launchPreferences } }
  useAppStore.setState({
    settings: { ...settings, experimentalNativeChat: chat },
    detectedAgentIds: ['claude', 'codex'],
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] }
  })
  setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT, ...(capable ? [SURFACE] : [])])
  const onStart = vi.fn().mockResolvedValue(true)
  const onSaveAgentDefault = vi.fn()
  const view = renderHook(() =>
    useSourceControlAgentActionDialog({
      open: true,
      initialRecipe,
      onOpenChange: () => {},
      actionId: 'resolveConflicts',
      title: '',
      description: '',
      baseCommandInput: 'fix',
      launchSource: 'source_control_recovery',
      savedAgentId: null,
      onStart,
      onSaveAgentDefault
    })
  )
  return { ...view, onStart, onSaveAgentDefault, launchPreferences }
}

it('starts and saves a live pick from the unified picker, keeping the agent-bound model', async () => {
  const { result, onStart, onSaveAgentDefault, launchPreferences } = renderDialog(true)
  await waitFor(() => expect(result.current.canStart).toBe(true))
  // An untouched default recipe stays the default and saves no surface of its own.
  expect(result.current.selectedAgent).toBe('claude')
  expect(result.current.recipe).toMatchObject({ agentId: null, launchPreferences })
  expect(result.current.agentArgsApply).toBe(false)

  act(() => result.current.surfaceRows.onPick('codex', 'terminal'))
  expect(result.current.recipe).toMatchObject({ agentId: 'codex', surface: 'terminal' })
  expect(result.current.recipe.launchPreferences).toEqual(launchPreferences)
  expect(result.current.surfaceRows.selection.cli).toBe(true)
  expect(result.current.agentArgsApply).toBe(true)
  await act(() => result.current.handleStart())

  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'codex',
      launchChoice: expect.objectContaining({
        route: 'terminal-tui',
        requestedSurface: 'terminal'
      })
    })
  )
  expect(onSaveAgentDefault).toHaveBeenCalledWith(
    { type: 'global' },
    'resolveConflicts',
    expect.objectContaining({ agentId: 'codex', surface: 'terminal' })
  )

  act(() => result.current.surfaceRows.onPick('claude', 'chat'))
  expect(result.current.recipe).toMatchObject({ agentId: 'claude', surface: 'chat' })
  expect(result.current.recipe.launchPreferences).toBeUndefined()
  expect(result.current.agentArgsApply).toBe(false)
})

it('saves no surface for a pick made when the picker offers no chats', async () => {
  const { result, onStart, onSaveAgentDefault } = renderDialog(false)
  await waitFor(() => expect(result.current.canStart).toBe(true))

  act(() => result.current.surfaceRows.onPick('codex', 'terminal'))
  await act(() => result.current.handleStart())

  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({ launchChoice: expect.objectContaining({ route: 'terminal-tui' }) })
  )
  const savedRecipe = onSaveAgentDefault.mock.calls[0]?.[2]
  expect(savedRecipe).toMatchObject({ agentId: 'codex' })
  expect(savedRecipe).not.toHaveProperty('surface')
})

it('leaves an untouched saved surface in the draft but omits it when saving to an older action host', async () => {
  const { result, onSaveAgentDefault } = renderDialog(true, false, {
    agentId: 'codex',
    surface: 'terminal'
  })
  await waitFor(() => expect(result.current.canStart).toBe(true))
  expect(result.current.recipe.surface).toBe('terminal')
  expect(result.current.agentArgsApply).toBe(true)
  act(() => result.current.onCommandTemplateChange('edited {basePrompt}'))
  await act(() => result.current.handleStart())
  const saved = onSaveAgentDefault.mock.calls[0]?.[2]
  expect(saved).not.toHaveProperty('surface')
  expect(saved).not.toHaveProperty('agentArgs')
  expect(result.current.recipe.surface).toBe('terminal')
})

it('allows replacing an unavailable saved agent without making it launchable', async () => {
  const f = renderDialog(false, true, { agentId: 'codex', agentArgs: '' })
  await act(async () =>
    useAppStore.setState({
      detectedAgentIds: ['claude'],
      localDetectedAgentIdsByContext: { host: ['claude'] }
    })
  )
  expect(f.result.current.surfaceRows.selection.ready).toBe(true)
  expect(f.result.current.canStart).toBe(false)
  expect(f.result.current.recipe.agentId).toBe('codex')
  expect(f.onStart).not.toHaveBeenCalled()
  act(() => f.result.current.surfaceRows.onPick('claude', 'terminal'))
  await waitFor(() => expect(f.result.current.canStart).toBe(true))
})

const hostRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: hostRpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
it.each(['codex', null] as const)(
  'uses the offered host identity for delivery and scope, preserving authored %s',
  async (agentId) => {
    const reply = Promise.withResolvers<{
      settings: ReturnType<typeof projectAgentLaunchSettings>
    }>()
    hostRpc.mockReturnValue(reply.promise)
    const settings = {
      ...getDefaultSettings('/tmp/host-action'),
      defaultTuiAgent: 'opencode' as const,
      disabledTuiAgents: ['codex' as const],
      experimentalNativeChat: false
    }
    const recipe = {
      agentId,
      surface: 'terminal' as const,
      agentArgs: '--model chosen',
      launchPreferences: { agentId: 'codex' as const, model: 'chosen' }
    }
    const repo: Repo = {
      ...TEST_REPO,
      executionHostId: 'runtime:alpha',
      sourceControlAi: {
        actionOverrides: {
          resolveConflicts: {
            agentId: 'codex' as const,
            launchPreferences: recipe.launchPreferences
          }
        }
      }
    }
    useAppStore.setState({
      settings,
      repos: [repo],
      worktreesByRepo: {
        [repo.id]: [makeWorktree({ id: 'wt', repoId: repo.id, hostId: 'runtime:alpha' })]
      },
      runtimeDetectedAgentIds: {
        [getRuntimeAgentInventoryKey('alpha', 'wt')]: ['claude', 'codex', 'opencode']
      },
      ensureRuntimeDetectedAgents: vi.fn().mockResolvedValue(['claude', 'codex', 'opencode']),
      refreshRuntimeDetectedAgents: vi.fn().mockResolvedValue(['claude', 'codex', 'opencode'])
    })
    const onStart = vi.fn().mockResolvedValue(true)
    const onSaveAgentDefault = vi.fn()
    const view = renderHook(() =>
      useSourceControlAgentActionDialog({
        open: true,
        initialRecipe: recipe,
        onOpenChange: vi.fn(),
        actionId: 'resolveConflicts',
        title: '',
        description: '',
        baseCommandInput: 'fix',
        launchSource: 'source_control_recovery',
        worktreeId: 'wt',
        repoId: repo.id,
        connectionId: null,
        onStart,
        onSaveAgentDefault
      })
    )
    expect(view.result.current.canStart).toBe(false)
    expect(view.result.current.saveTargetValue).toBe('repo')
    act(() => view.result.current.onSaveAgentDefaultChange('global'))
    await act(async () =>
      reply.resolve({
        settings: projectAgentLaunchSettings({
          defaultTuiAgent: 'codex',
          disabledTuiAgents: ['opencode', 'claude']
        })
      })
    )
    expect(view.result.current.surfaceRows.model).toMatchObject({
      state: 'settled',
      rows: [{ agent: 'codex', kind: 'terminal' }]
    })
    expect(view.result.current.selectedAgent).toBe('codex')
    expect(view.result.current.canStart).toBe(true)
    expect(view.result.current.saveTargetValue).toBe('global')
    expect(view.result.current.agentScopeNote).toBeNull()
    await act(() => view.result.current.handleStart())
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        agentArgs: '--dangerously-bypass-approvals-and-sandbox --model chosen',
        sessionOptions: { model: 'chosen' },
        agentLaunchPreferences: {
          defaultTuiAgent: 'codex',
          disabledTuiAgents: ['opencode', 'claude']
        }
      })
    )
    expect(onSaveAgentDefault).toHaveBeenCalledWith(
      { type: 'global' },
      'resolveConflicts',
      expect.objectContaining({ agentId, agentArgs: '--model chosen' })
    )
    expect(useAppStore.getState().settings).toBe(settings)
  }
)

it('offers an unset cold-failed command in the actual dialog, saves it and starts through the real validator', async () => {
  const settings = {
    ...getDefaultSettings('/tmp'),
    defaultTuiAgent: 'blank' as const,
    experimentalNativeChat: false
  }
  useAppStore.setState({
    settings,
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'cold', repoId: TEST_REPO.id })] }
  })
  useAppStore.getState().clearLocalDetectedAgents()
  Object.assign(window, {
    api: {
      ...window.api,
      preflight: { detectAgents: vi.fn().mockRejectedValue(new Error('capture failed')) }
    }
  })
  setLocalRuntimeCapabilitiesForTests([])
  await useAppStore.getState().ensureDetectedAgents('cold')
  const onStart = vi.fn().mockResolvedValue(true),
    onSaveAgentDefault = vi.fn()
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    actionId: 'fixChecks' as const,
    title: 'Fix checks',
    description: '',
    baseCommandInput: 'repair checks',
    worktreeId: 'cold',
    repoId: TEST_REPO.id,
    connectionId: null,
    savedAgentId: null,
    initialRecipe: { agentId: null, agentArgs: '--verbose', commandInputTemplate: '{basePrompt}' },
    launchSource: 'task_page' as const,
    onStart,
    onSaveAgentDefault
  }
  const view = render(
    <TooltipProvider>
      <SourceControlAgentActionDialog {...props} />
    </TooltipProvider>
  )
  await waitFor(() => expect(view.getByRole('combobox').hasAttribute('disabled')).toBe(false))
  expect(view.getByRole('combobox').textContent).toContain('Select an Agent')
  fireEvent.click(view.getByRole('combobox'))
  const row = view.getAllByRole('option').find((option) => option.textContent?.startsWith('Claude'))
  if (!row) {
    throw new Error('Missing dialog configuration command')
  }
  fireEvent.click(row)
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Save & start agent' })))
  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'claude',
      commandInput: 'repair checks',
      agentArgs: '--dangerously-skip-permissions --verbose'
    })
  )
  expect(onSaveAgentDefault).toHaveBeenCalledWith(
    expect.anything(),
    'fixChecks',
    expect.objectContaining({ agentId: 'claude', agentArgs: '--verbose' })
  )
  expect(useAppStore.getState().readLocalAgentInventory('cold')).toEqual({
    ids: null,
    state: 'failed'
  })
  view.unmount()
  onStart.mockClear()
  const reentry = renderHook(() =>
    useSourceControlAgentActionDialog({
      ...props,
      initialRecipe: { ...props.initialRecipe, agentId: 'claude' }
    })
  )
  await waitFor(() => expect(reentry.result.current.canStart).toBe(true))
  act(() => useAppStore.setState({ settings: { ...settings, disabledTuiAgents: ['claude'] } }))
  await act(() => reentry.result.current.handleStart())
  expect(onStart).not.toHaveBeenCalled()
})

it.each(['disabled', 'retargeted', 'draft-edited'] as const)(
  'refuses a cold saved dialog intent made %s during recovery before saving or dispatch',
  async (change) => {
    resetRendererAppPlatformCacheForTests()
    const recovery = Promise.withResolvers<{ inFlight: boolean }>()
    const mutationInFlight = vi.fn(() => recovery.promise)
    Object.assign(window, {
      api: {
        ...window.api,
        platform: { get: () => ({ platform: 'win32' }) },
        git: { mutationInFlight },
        preflight: { detectAgents: vi.fn().mockRejectedValue(new Error('cold failed')) }
      }
    })
    const settings = {
      ...getDefaultSettings('/tmp'),
      experimentalNativeChat: false,
      localWindowsRuntimeDefault: { kind: 'wsl' as const, distro: 'Ubuntu' }
    }
    useAppStore.getState().clearLocalDetectedAgents()
    useAppStore.setState({
      settings,
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'recovery', repoId: TEST_REPO.id })] }
    })
    setLocalRuntimeCapabilitiesForTests([])
    await useAppStore.getState().ensureDetectedAgents('recovery')
    const onStart = vi.fn().mockResolvedValue(true),
      onSaveAgentDefault = vi.fn()
    const f = renderHook(() =>
      useSourceControlAgentActionDialog({
        open: true,
        onOpenChange: vi.fn(),
        actionId: 'fixChecks',
        title: '',
        description: '',
        baseCommandInput: 'fix',
        launchSource: 'task_page',
        initialRecipe: {
          agentId: 'claude',
          agentArgs: '--verbose',
          commandInputTemplate: '{basePrompt}'
        },
        repoId: TEST_REPO.id,
        worktreeId: 'recovery',
        connectionId: null,
        onStart,
        onSaveAgentDefault,
        recoveryContext: {
          target: { kind: 'local' },
          worktreeId: 'recovery',
          worktreePath: '/repo'
        }
      })
    )
    await waitFor(() => expect(f.result.current.canStart).toBe(true))
    let started = Promise.resolve()
    act(() => {
      started = f.result.current.handleStart()
    })
    await waitFor(() => expect(mutationInFlight).toHaveBeenCalledOnce())
    if (change === 'draft-edited') {
      act(() => f.result.current.onAgentArgsChange('--changed'))
    } else {
      act(() =>
        useAppStore.setState({
          settings:
            change === 'disabled'
              ? { ...settings, disabledTuiAgents: ['claude'] }
              : { ...settings, localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' } }
        })
      )
    }
    await act(async () => {
      recovery.resolve({ inFlight: false })
      await started
    })
    expect(onStart).not.toHaveBeenCalled()
    expect(onSaveAgentDefault).not.toHaveBeenCalled()
    f.unmount()
    resetRendererAppPlatformCacheForTests()
  }
)
