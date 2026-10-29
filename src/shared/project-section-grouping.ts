import { getRepoExecutionHostId } from './execution-host'
// The desktop sidebar's Project sections; the paired phone calls these same functions.
import type { ExecutionHostId } from './execution-host'
import { orderProjectSections, type ActivityItem } from './project-section-order'
import type { ProjectOrderBy } from './ui-chrome-types'
import {
  buildProjectGroups,
  getProjectCheckoutPathKey,
  type ProjectGroupingSettings,
  type CheckoutProjectGroup,
  type GroupingSetup
} from './project-grouping'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'

/** The project fields grouping reads. */
export type ProjectSectionProject = Pick<Project, 'id' | 'displayName'>

/** The host-setup fields grouping and host labels read. */
export type ProjectSectionSetup = GroupingSetup

export type ProjectGroupingModel = {
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  settings?: ProjectGroupingSettings | null
}

/** What grouping reads of a model; a paired phone receives only this much. */
export type ProjectSectionModel = {
  projects: readonly ProjectSectionProject[]
  projectHostSetups: readonly ProjectSectionSetup[]
  settings?: ProjectGroupingSettings | null
}

export type ProjectGroupingIndex = {
  projectById: Map<string, ProjectSectionProject>
  setupByRepoId: Map<string, ProjectSectionSetup>
  groupByRepoId: Map<string, CheckoutProjectGroup>
  groupByRepoHost: Map<string, CheckoutProjectGroup>
  setupByRepoHost: Map<string, ProjectSectionSetup>
}

/** The repo fields section grouping, labelling and ordering read. */
export type ProjectSectionRepo = {
  id: string
  displayName: string
  path: string
  addedAt?: number
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}

/** One project section: its rows, the repo that anchors its header, and every repo it holds. */
export type ProjectSectionEntry<Item, R extends ProjectSectionRepo = Repo> = {
  label: string
  items: Item[]
  /** Owning-project activity, when display placement files rows under another project. */
  activityItems?: readonly Item[]
  repo?: R
  repoIds: Set<string>
}

const indexCache = new WeakMap<
  ProjectSectionModel,
  { groups: CheckoutProjectGroup[]; index: ProjectGroupingIndex }
>()

export function buildProjectGroupingIndex(
  model?: ProjectSectionModel
): ProjectGroupingIndex | null {
  if (!model) {
    return null
  }
  const groups = buildProjectGroups(model)
  const cached = indexCache.get(model)
  if (cached?.groups === groups) {
    return cached.index
  }
  const groupByCheckout = new Map(
    groups.flatMap((group) =>
      group.members.map((member) => [getProjectCheckoutPathKey(member), group] as const)
    )
  )
  const index: ProjectGroupingIndex = {
    projectById: new Map(model.projects.map((project) => [project.id, project])),
    setupByRepoHost: new Map(
      model.projectHostSetups.map((setup) => [`${setup.hostId}\0${setup.repoId}`, setup])
    ),
    groupByRepoHost: new Map(
      model.projectHostSetups.flatMap((setup) => {
        const group = groupByCheckout.get(getProjectCheckoutPathKey(setup))
        return group ? [[`${setup.hostId}\0${setup.repoId}`, group] as const] : []
      })
    ),
    setupByRepoId: new Map(model.projectHostSetups.map((setup) => [setup.repoId, setup])),
    groupByRepoId: new Map(
      model.projectHostSetups.flatMap((setup) => {
        const group = groupByCheckout.get(getProjectCheckoutPathKey(setup))
        return group ? [[setup.repoId, group] as const] : []
      })
    )
  }
  indexCache.set(model, { groups, index })
  return index
}

export type ProjectHeaderRevealTarget<
  R extends Pick<ProjectSectionRepo, 'displayName'> & Partial<ProjectSectionRepo> = Repo
> = {
  key: string
  label: string
  repo?: R
  projectId?: string
}

export function getProjectGroupingForRepo<
  R extends Pick<ProjectSectionRepo, 'displayName'> & Partial<ProjectSectionRepo>
>(
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null,
  hostId?: string
): ProjectHeaderRevealTarget<R> {
  const repo = repoMap.get(repoId)
  const repoHost = hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
  const identity = `${repoHost}\0${repoId}`
  const setup =
    projectIndex?.setupByRepoHost.get(identity) ?? projectIndex?.setupByRepoId.get(repoId)
  const project = setup ? projectIndex?.projectById.get(setup.projectId) : undefined
  if (!setup || !project) {
    return {
      key: `repo:${repoId}`,
      label: repo?.displayName ?? 'Unknown',
      repo
    }
  }
  const group =
    projectIndex?.groupByRepoHost.get(identity) ?? projectIndex?.groupByRepoId.get(repoId)
  return {
    key: group?.key ?? `project:${project.id}`,
    label: group?.label ?? project.displayName,
    repo,
    projectId: project.id
  }
}

export function getProjectHeaderRevealTarget(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectGrouping?: ProjectGroupingModel,
  hostId?: string
): ProjectHeaderRevealTarget {
  return getProjectGroupingForRepo(
    repoId,
    repoMap,
    buildProjectGroupingIndex(projectGrouping),
    hostId
  )
}

/** Actual membership, independent of where a lineage occurrence is displayed. */
export function buildProjectOwnershipIndex<Item, R extends ProjectSectionRepo>(args: {
  items: readonly Item[]
  repoIdOf: (item: Item) => string
  hostIdOf?: (item: Item) => string | undefined
  repoMap: ReadonlyMap<string, R>
  projectIndex: ProjectGroupingIndex | null
}): Map<string, { items: Item[]; repoIds: Set<string> }> {
  const ownership = new Map<string, { items: Item[]; repoIds: Set<string> }>()
  for (const item of args.items) {
    const repoId = args.repoIdOf(item)
    const key = getProjectGroupingForRepo(
      repoId,
      args.repoMap,
      args.projectIndex,
      args.hostIdOf?.(item)
    ).key
    const entry = ownership.get(key) ?? { items: [], repoIds: new Set<string>() }
    entry.items.push(item)
    entry.repoIds.add(repoId)
    ownership.set(key, entry)
  }
  return ownership
}

function addItemToProjectSection<Item, R extends ProjectSectionRepo>(
  sections: Map<string, ProjectSectionEntry<Item, R>>,
  item: Item,
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null,
  hostId?: string
): void {
  const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex, hostId)
  let section = sections.get(grouping.key)
  if (!section) {
    section = { label: grouping.label, items: [], repo: grouping.repo, repoIds: new Set() }
    sections.set(grouping.key, section)
  }
  section.items.push(item)
  section.repoIds.add(repoId)
}

/** Open empty repo sections; requireRepo skips missing catalog IDs instead of showing Unknown. */
function ensureProjectSectionForRepo<Item, R extends ProjectSectionRepo>(
  sections: Map<string, ProjectSectionEntry<Item, R>>,
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null,
  options: { requireRepo?: boolean; fallbackRepo?: R } = {}
): void {
  const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex)
  if (options.requireRepo && !grouping.repo) {
    return
  }
  const section = sections.get(grouping.key)
  if (section) {
    section.repoIds.add(repoId)
    return
  }
  sections.set(grouping.key, {
    label: grouping.label,
    items: [],
    repo: grouping.repo ?? options.fallbackRepo,
    repoIds: new Set([repoId])
  })
}

/** Build unlabelled sections: rows, placeholders, notice repos (with catalog fallback), then pending workspace repos.
 * Header order is applied here; withRepoSectionDisplayLabels supplies labels. */
export function buildProjectSections<
  Item extends ActivityItem,
  R extends ProjectSectionRepo
>(args: {
  items: readonly Item[]
  repoIdOf: (item: Item) => string
  hostIdOf?: (item: Item) => string | undefined
  displayRepoIdOf?: (item: Item) => string
  repoMap: ReadonlyMap<string, R>
  projectIndex: ProjectGroupingIndex | null
  placeholderRepoIds: Iterable<string>
  noticeRepos?: Iterable<readonly [string, R | undefined]>
  pendingRepoIds?: Iterable<string>
  repoOrder: ReadonlyMap<string, number> | undefined
  projectOrderBy: ProjectOrderBy
}): [string, ProjectSectionEntry<Item, R>][] {
  const { repoMap, projectIndex } = args
  const sections = new Map<string, ProjectSectionEntry<Item, R>>()
  const ownership = buildProjectOwnershipIndex(args)
  for (const item of args.items) {
    const repoId = args.repoIdOf(item)
    addItemToProjectSection(
      sections,
      item,
      args.displayRepoIdOf?.(item) ?? repoId,
      repoMap,
      projectIndex,
      args.hostIdOf?.(item)
    )
  }
  // Repos may precede scans; ignore stale placeholder IDs instead of rendering Unknown headers.
  for (const repoId of args.placeholderRepoIds) {
    ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex, { requireRepo: true })
  }
  // Pinned worktrees leave natural groups, but actionable notices still need project sections.
  for (const [repoId, fallbackRepo] of args.noticeRepos ?? []) {
    ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex, { fallbackRepo })
  }
  // Ensure a section for first-workspace creation so its pending row is not dropped.
  for (const repoId of args.pendingRepoIds ?? []) {
    ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex)
  }
  for (const [key, section] of sections) {
    section.activityItems = ownership.get(key)?.items ?? []
  }
  return orderProjectSections(sections, repoMap, args.repoOrder, args.projectOrderBy)
}
