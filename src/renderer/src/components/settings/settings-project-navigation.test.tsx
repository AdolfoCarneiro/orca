// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useShallow } from 'zustand/react/shallow'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '../../store'
import { ActiveSettingsSectionProvider } from './SettingsSection'
import {
  buildRepoIdToHostSelection,
  buildRepoIdToRepresentative,
  buildSettingsProjectList
} from './settings-project-list'
import { renderProjectSettingsSections } from './settings-project-section-renderer'
import { useSettingsPageEffects } from './use-settings-page-effects'
import type { SettingsRenderContext } from './settings-render-context'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'

vi.mock('./repository/RepositoryPane', () => ({
  RepositoryPane: () => <output>Project pane</output>
}))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => useAppStore.setState(useAppStore.getInitialState(), true))

it.each(['host', 'folder'] as const)(
  'renders and reaches host-qualified legacy links with real %s group IDs',
  (mode) => {
    const base: Repo = {
      id: 'same',
      displayName: 'App',
      path: '/local/app',
      badgeColor: '',
      addedAt: 0,
      gitRemoteIdentity: {
        canonicalKey: 'gitlab.com/acme/app',
        remoteName: 'origin',
        remoteUrl: 'https://gitlab.com/acme/app.git'
      }
    }
    const repos: Repo[] = [base, { ...base, path: '/remote/app', executionHostId: 'ssh:box' }]
    const projection = projectHostSetupProjectionFromRepos(repos)
    const settings = { ...getDefaultSettings('/tmp'), projectGroupingMode: mode }
    const entries = buildSettingsProjectList(repos, {
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings
    })
    const repoIdToHostSelection = buildRepoIdToHostSelection(entries)
    const repoIdToRepresentative = buildRepoIdToRepresentative(entries)
    const noop = vi.fn()
    const fetch = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ repos, settings })
    let scrollTarget: string | null = null
    function Harness({ hostId }: { hostId: 'local' | 'ssh:box' }) {
      const state = useAppStore(
        useShallow((state) => ({
          repos: state.repos,
          keybindings: state.keybindings,
          updateRepo: state.updateRepo,
          updateProject: state.updateProject,
          settingsProjectHostSelection: state.settingsProjectHostSelection,
          settingsProjectSetupSelection: state.settingsProjectSetupSelection,
          setSettingsProjectHostSelection: state.setSettingsProjectHostSelection
        }))
      )
      const [mounted, setMountedSectionIds] = useState(new Set<string>())
      const [, setPendingNavRequestTick] = useState(0)
      const pendingNavSectionRef = useRef<string | null>(null)
      const pendingScrollTargetRef = useRef<string | null>(null)
      const [target] = useState({
        pane: 'repo',
        repoId: 'same',
        sectionId: 'repo-same',
        hostId
      } as const)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies every field read by the production page effects and project-section renderer.
      const model = {
        ...state,
        settings,
        settingsProjectList: entries,
        repoIdToHostSelection,
        repoIdToRepresentative,
        settingsNavigationTarget: target,
        activeSectionId: 'general',
        clearSettingsTarget: noop,
        fetchSettings: fetch,
        fetchKeybindings: fetch,
        showDesktopOnlySettings: false,
        repoHooksMap: {},
        removeProjectAllHosts: fetch,
        setVoiceModelStatesLoading: noop,
        setMountedSectionIds,
        setPendingNavRequestTick,
        setSettingsHostChoice: noop,
        setHighlightedSettingsTargetId: noop,
        setQuickCommandAddIntentSignal: noop,
        setRemoteServerAddIntentSignal: noop,
        setSshHostAddIntentSignal: noop
      } as SettingsStoreModel
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies the effect's refs/callbacks; unrelated interaction fields are never read.
      const interactions = {
        pendingNavSectionRef,
        pendingScrollTargetRef,
        searchInputRef: useRef<HTMLInputElement | null>(null),
        shortcutsEscapeConfirmUntilRef: useRef(0),
        hasUnsavedSourceControlAiPromptChangesRef: useRef(false),
        closeSettingsPageWithPromptGuard: fetch,
        promptDiscardSourceControlAiPromptChanges: fetch
      } as SettingsInteractionController
      useSettingsPageEffects(model, interactions)
      scrollTarget = pendingScrollTargetRef.current
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this renderer reads only model, navigation, terminal capabilities and isSectionMounted.
      const context = {
        model,
        navigation: { getSectionSearchEntries: () => [] },
        terminal: { windowsTerminalCapabilities: {}, isWindowsTerminalHost: false },
        view: { isSectionMounted: (id: string) => mounted.has(id) }
      } as SettingsRenderContext
      return (
        <ActiveSettingsSectionProvider value={pendingNavSectionRef.current}>
          {renderProjectSettingsSections(context)}
        </ActiveSettingsSectionProvider>
      )
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      for (const [hostId, path] of [
        ['local', base.path],
        ['ssh:box', '/remote/app']
      ] as const) {
        act(() => root.render(<Harness key={hostId} hostId={hostId} />))
        const entry = entries.find((candidate) => candidate.representativeHostId === hostId)!
        const id = `repo-${entry.selectionKey}`
        expect(id).toContain('gitlab.com/acme/app')
        expect(document.getElementById(id)?.textContent).toContain(path)
        expect(container.querySelectorAll('section[data-settings-section]')).toHaveLength(1)
        expect(scrollTarget).toBe(id)
        expect(container.textContent).toContain('Project pane')
      }
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  }
)
