// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AutomationEditorDialog, type AutomationDraft } from './AutomationEditorDialog'
import { makeStoreState } from './automations-page-fixtures'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  AUTOMATION_SURFACE_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AutomationSurfaceField } from './AutomationSurfaceField'
import { automationDraftSurface } from './automation-launch-surface'
import { buildAutomationEditDraft } from './automation-edit-draft'
import { buildProfileStateCutoverFixture } from '../../../../main/persistence/profile-state-cutover-fixture'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof routeState) => unknown) => selector(routeState)
}))
vi.mock('@/lib/host-chat-program-acquisition', () => ({ useChatProgramFacts: () => undefined }))
vi.mock('./AutomationEditorPromptEditor', () => ({ getAutomationPromptEditorRoot: () => null }))
vi.mock('./AutomationEditorPromptSection', () => ({ AutomationEditorPromptSection: () => null }))
vi.mock('./AutomationEditorSettingsSidebar', () => ({
  AutomationEditorSettingsSidebar: () => null
}))
vi.mock('./AutomationEditorDialogHeader', () => ({ AutomationEditorDialogHeader: () => null }))

let routeState = makeStoreState().state
beforeEach(() => {
  routeState = makeStoreState().state
})
afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this pure control reads only the default switch and selected agent/surface.
const settings = { experimentalNativeChat: true } as GlobalSettings
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unrelated editor fields are never read by this control.
const draft = { agentId: 'claude', extraAgentArgs: '--model opus' } as AutomationDraft
afterEach(cleanup)
it('places the current default on the right, highlights it, and preserves arguments through toggles', () => {
  const change = vi.fn()
  render(
    <AutomationSurfaceField draft={draft} settings={settings} supported onDraftChange={change} />
  )
  const radios = screen.getAllByRole('radio')
  expect(radios.map((radio) => radio.textContent)).toEqual(['Terminal', 'Chat'])
  expect(radios[1].getAttribute('aria-checked')).toBe('true')
  fireEvent.click(radios[0])
  expect(change.mock.calls[0][0](draft)).toMatchObject({
    surface: 'terminal',
    extraAgentArgs: '--model opus'
  })
})
it('keeps legacy automations Terminal when the current default is Chat', () => {
  const legacy = buildAutomationEditDraft(
    buildProfileStateCutoverFixture('/fixture').automations[0]
  )
  expect(legacy.surface).toBe('terminal')
  expect(automationDraftSurface(legacy, settings, true)).toBe('terminal')
})
it('reserves disabled controls until host support is known and hides Chat on unsupported hosts', () => {
  const props = { draft, settings, onDraftChange: vi.fn() }
  const view = render(<AutomationSurfaceField {...props} supported={null} />)
  expect(screen.getAllByRole('radio').every((radio) => radio.hasAttribute('disabled'))).toBe(true)
  expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-checked'))).toEqual([
    'false',
    'true'
  ])
  view.rerender(<AutomationSurfaceField {...props} supported />)
  expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-checked'))).toEqual([
    'false',
    'true'
  ])
  expect(screen.getAllByRole('radio').some((radio) => radio.hasAttribute('disabled'))).toBe(false)
  view.rerender(<AutomationSurfaceField {...props} supported={false} />)
  expect(screen.queryByRole('radio')).toBeNull()
})
it('rederives unknown native preference for the current agent while explicit and legacy Terminal win', () => {
  const perAgent = { ...settings, nativeChatProviders: { claude: false } }
  expect(automationDraftSurface(draft, perAgent, null)).toBe('terminal')
  expect(automationDraftSurface({ ...draft, agentId: 'codex' }, perAgent, null)).toBe('chat')
  for (const supported of [null, true, false]) {
    expect(automationDraftSurface({ ...draft, surface: 'terminal' }, settings, supported)).toBe(
      'terminal'
    )
  }
  expect(automationDraftSurface({ ...draft, surface: 'chat' }, settings, false)).toBe('chat')
})

it('the real dialog footer withholds an unchosen native Chat save until support resolves', () => {
  const fixtures = makeStoreState()
  const { surface: _legacy, ...newDraft } = buildAutomationEditDraft(
    buildProfileStateCutoverFixture('/fixture').automations[0]
  )
  const onSave = vi.fn()
  const props = {
    open: true,
    isEditing: false,
    isSaving: false,
    canSave: true,
    repos: fixtures.state.repos,
    projectHostSetups: fixtures.state.projectHostSetups,
    automationYamlHooksByRepoKey: {},
    getAutomationHooksCacheKey: (id: string) => id,
    repoMap: fixtures.repoMap,
    worktrees: [...fixtures.worktreeMap.values()],
    settings,
    draft: { ...newDraft, agentId: 'claude' as const },
    onProjectChange: vi.fn(),
    onOpenChange: vi.fn(),
    onDraftChange: vi.fn(),
    onSetupDecisionTouched: vi.fn(),
    onApplyTemplate: vi.fn(),
    onSave
  }
  setLocalRuntimeCapabilitiesForTests(null)
  const view = render(<AutomationEditorDialog {...props} />)
  const button = screen.getByRole('button', { name: 'Create' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  expect(onSave).not.toHaveBeenCalled()
  setLocalRuntimeCapabilitiesForTests([
    AUTOMATION_SURFACE_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
  ])
  view.rerender(<AutomationEditorDialog {...props} />)
  expect(button.hasAttribute('disabled')).toBe(false)
  fireEvent.click(button)
  expect(onSave).toHaveBeenCalledOnce()
  setLocalRuntimeCapabilitiesForTests(null)
  view.rerender(
    <AutomationEditorDialog {...props} draft={{ ...props.draft, surface: 'terminal' }} />
  )
  expect(button.hasAttribute('disabled')).toBe(false)
  view.rerender(<AutomationEditorDialog {...props} draft={{ ...props.draft, surface: 'chat' }} />)
  expect(button.hasAttribute('disabled')).toBe(true)
  setLocalRuntimeCapabilitiesForTests([])
  view.rerender(<AutomationEditorDialog {...props} draft={{ ...props.draft, surface: 'chat' }} />)
  expect(button.hasAttribute('disabled')).toBe(true)
})
