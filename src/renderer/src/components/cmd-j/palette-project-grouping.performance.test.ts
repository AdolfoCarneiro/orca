import { describe, expect, it } from 'vitest'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { buildPaletteFilterModel } from './palette-filter-options'
import { hasCmdJProjectSearchCandidates, searchCmdJProjectResults } from './palette-project-results'

describe('palette project grouping operation bound', () => {
  it.each([100, 1000])('indexes %i projects once per presence, query and filter pass', (count) => {
    const repos = Array.from({ length: count }, (_, index) => ({
      id: `repo-${index}`,
      path: `/repos/${index}`,
      displayName: `app-${index}`,
      badgeColor: '',
      addedAt: 0
    }))
    const projection = projectHostSetupProjectionFromRepos(repos)
    let reads = 0
    const projects = projection.projects.map((project) => ({
      ...project,
      get id() {
        reads++
        return project.id
      }
    }))
    const input = { repos, projects, projectHostSetups: projection.setups, projectGroups: [] }
    expect(hasCmdJProjectSearchCandidates(input)).toBe(true)
    expect(reads).toBeLessThanOrEqual(10 * count)
    reads = 0
    expect(searchCmdJProjectResults({ ...input, query: 'app' })).toHaveLength(count)
    expect(reads).toBeLessThanOrEqual(10 * count)
    reads = 0
    const filters = buildPaletteFilterModel({ ...input, worktrees: [], hostOptions: [] })
    expect(filters.repoIdsByProjectKey.size).toBe(count)
    expect(reads).toBeLessThanOrEqual(10 * count)
  })
})
