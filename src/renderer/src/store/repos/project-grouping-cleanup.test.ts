import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '..'
import { getDefaultSettings } from '../../../../shared/constants'
import { retireRemovedProjectGroupingState } from './project-grouping-preferences'
import type { SettingsUpdate } from '../slices/settings'
import type { Repo } from '../../../../shared/repo-types'

const repo: Repo = {
  id: 'a',
  path: '/a',
  displayName: 'App',
  badgeColor: '',
  addedAt: 0,
  upstream: { owner: 'org', repo: 'app' }
}
afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

it.each([100, 1000])(
  'retires %i historical collapse keys in one current-state mutation',
  async (count) => {
    const persist = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: persist } } })
    const unrelated = Array.from({ length: count }, (_, i) => `project-group:other-${i}`)
    const settings = {
      ...getDefaultSettings(''),
      projectGroupingOverrides: { 'github:org/app': 'folder' as const, offline: 'host' as const }
    }
    const updateSettingsOrThrow = vi.fn(async (transform: SettingsUpdate) => {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings!,
          ...(typeof transform === 'function'
            ? transform(useAppStore.getState().settings!)
            : transform)
        }
      })
    })
    useAppStore.setState({
      repos: [],
      settings,
      collapsedGroups: new Set([
        ...Array.from(
          { length: count },
          (_, i) => `project:github:org/app::host:local::setup:${i}`
        ),
        ...unrelated
      ]),
      updateSettingsOrThrow
    })
    // A later unrelated collapse is read by the mutation, not overwritten by a pre-removal snapshot.
    useAppStore.getState().toggleCollapsedGroup('project:repo:plain')
    persist.mockClear()
    let visited = 0
    class MeasuredSet extends Set<string> {
      override *[Symbol.iterator](): SetIterator<string> {
        for (const key of super[Symbol.iterator]()) {
          visited++
          yield key
        }
      }
    }
    useAppStore.setState({
      collapsedGroups: new MeasuredSet(useAppStore.getState().collapsedGroups)
    })
    let publications = 0
    const stop = useAppStore.subscribe((state, previous) => {
      if (state.collapsedGroups !== previous.collapsedGroups) {
        publications++
      }
    })
    retireRemovedProjectGroupingState(useAppStore.getState, repo)
    await Promise.resolve()
    expect(visited).toBe(2 * count + 1)
    expect(publications).toBe(1)
    expect(persist).toHaveBeenCalledExactlyOnceWith({
      collapsedGroups: [...unrelated, 'project:repo:plain']
    })
    expect(useAppStore.getState().settings?.projectGroupingOverrides).toEqual({ offline: 'host' })
    persist.mockClear()
    retireRemovedProjectGroupingState(useAppStore.getState, repo)
    expect(persist).not.toHaveBeenCalled()
    expect(publications).toBe(1)
    useAppStore.setState({ repos: [{ ...repo, id: 'sibling' }] })
    updateSettingsOrThrow.mockClear()
    retireRemovedProjectGroupingState(useAppStore.getState, repo)
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    stop()
  }
)
