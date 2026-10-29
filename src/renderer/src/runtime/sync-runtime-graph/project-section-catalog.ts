import {
  buildMobileProjectSectionCatalog,
  type MobileProjectSectionCatalog
} from '../../../../shared/mobile-project-sections-contract'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import type { AppState } from '@/store/types'

type CatalogSource = {
  settings: AppState['settings']
  repos: AppState['repos']
  projection: ProjectHostSetupProjection
  projectOrderBy: AppState['projectOrderBy']
  catalog: MobileProjectSectionCatalog
}

let cachedCatalogSource: CatalogSource | null = null

/** What the sidebar groups Project headers by: state.repos in its order and the selector's projection. */
export function getProjectSectionCatalogFromState(
  state: Pick<AppState, 'repos' | 'projects' | 'projectHostSetups' | 'projectOrderBy'> &
    Partial<Pick<AppState, 'settings'>>
): MobileProjectSectionCatalog | null {
  // Why: graph publication must not fail on a store slice that holds no repo catalog.
  if (!Array.isArray(state.repos)) {
    return null
  }
  const projection = getProjectHostSetupProjectionFromState(state)
  const cached = cachedCatalogSource
  if (
    cached &&
    cached.repos === state.repos &&
    cached.settings === (state.settings ?? null) &&
    cached.projection === projection &&
    cached.projectOrderBy === state.projectOrderBy
  ) {
    return cached.catalog
  }
  const catalog = buildMobileProjectSectionCatalog(
    state.repos,
    projection,
    state.projectOrderBy,
    undefined,
    state.settings
  )
  cachedCatalogSource = {
    settings: state.settings ?? null,
    repos: state.repos,
    projection,
    projectOrderBy: state.projectOrderBy,
    catalog
  }
  return catalog
}
