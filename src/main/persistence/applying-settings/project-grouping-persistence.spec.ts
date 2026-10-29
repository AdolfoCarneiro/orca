import { it, expect } from 'vitest'
import type { Store } from '../loading-store/store'
import { getDefaultPersistedState } from '../../../shared/constants'
import { writeDataFile, testState } from '../persistence-test-harness'
import { buildProjectGroupingIndex } from '../../../shared/project-section-grouping'
import {
  selectedProjectFilterKeys,
  projectFilterMemberIds
} from '../../../shared/project-repo-filter-selection'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { projectRepoFilterMatcher } from '../../../shared/project-grouping'

export function registerProjectGroupingPersistenceTests(createStore: () => Promise<Store>) {
  it('loads existing settings with repository grouping and retains offline overrides through restart', async () => {
    const state = getDefaultPersistedState(testState.dir)
    Reflect.deleteProperty(state.settings, 'projectGroupingMode')
    Reflect.deleteProperty(state.settings, 'projectGroupingOverrides')
    writeDataFile(state)
    const store = await createStore()
    expect(store.getSettings()).toMatchObject({
      projectGroupingMode: 'repository',
      projectGroupingOverrides: {}
    })
    store.updateSettings({
      projectGroupingMode: 'folder',
      projectGroupingOverrides: { offline: 'host' }
    })
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getSettings()).toMatchObject({
      projectGroupingMode: 'folder',
      projectGroupingOverrides: { offline: 'host' }
    })
  })

  it('round-trips grouped desktop/current-phone and raw old-phone filters without losing offline scope', async () => {
    const repo = {
      id: 'a',
      displayName: 'app',
      path: '/app',
      badgeColor: '',
      addedAt: 0,
      upstream: { owner: 'org', repo: 'app' }
    }
    const repos = [
      repo,
      { ...repo, id: 'b', path: '/app-b' },
      { ...repo, executionHostId: 'runtime:server' as const }
    ]
    const projection = projectHostSetupProjectionFromRepos(repos)
    const index = buildProjectGroupingIndex({
      projects: projection.projects,
      projectHostSetups: projection.setups
    })
    expect(selectedProjectFilterKeys(index, ['b', 'offline'])).toEqual([])
    const selected = projectFilterMemberIds(index, [index.groups[0].key], ['b', 'offline'])
    expect(new Set(selected)).toEqual(new Set(['a', 'b', 'offline']))
    const store = await createStore()
    for (const field of ['filterRepoIds', 'agentsFilterRepoIds'] as const) {
      store.updateUI({ [field]: selected })
      expect(store.getUI()[field]).toEqual(selected)
      // Shipped peers can echo qualified values that their raw-ID controls do not understand.
      store.updateUI({ [field]: ['a', 'local\0a', 'runtime:server\0a', 'offline'] })
      store.updateUI({ [field]: ['local\0a', 'runtime:server\0a', 'offline'] })
      expect(store.getUI()[field]).toEqual(['offline'])
      store.updateUI({ [field]: ['runtime:server\0a', 'offline'] })
      expect(projectRepoFilterMatcher(store.getUI()[field])('a', 'local')).toBe(false)
      expect(projectRepoFilterMatcher(store.getUI()[field])('a', 'runtime:server')).toBe(true)
    }
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getUI().filterRepoIds).toEqual(['runtime:server\0a', 'offline'])
    expect(reloaded.getUI().agentsFilterRepoIds).toEqual(['runtime:server\0a', 'offline'])
  })
}
