import { setWithLRU } from '@/lib/scroll-cache'
import { invalidateCleanSections } from '@/components/editor/diff-section-invalidation'
import type { DiffSection } from '@/components/editor/diff-section-types'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'

export type CachedPRFilesDiffViewState = {
  entrySignature: string
  sections: DiffSection[]
  sectionHeights: Record<number, number>
  loadedIndices: number[]
  scrollTop: number
  sideBySide: boolean
  fileTreeCollapsed: boolean
  activeTreeSectionKey: string | null
}

const MAX_INACTIVE_PR_DIFF_BODY_CHARACTERS = 16_000_000
const bodyCharactersBySections = new WeakMap<DiffSection[], number>()
const mountedViewCounts = new Map<string, number>()
export const prFilesDiffViewStateCache = new Map<string, CachedPRFilesDiffViewState>()
export const prFilesDiffScrollTopCache = new Map<string, number>()

export function getPRFilesDiffViewKey(args: {
  repoId: string
  repoPath: string
  prNumber: number
  prRepo: GitHubOwnerRepo | null | undefined
  sourceHostId?: string
}): string {
  return [
    args.repoId || args.repoPath,
    args.prNumber,
    args.prRepo ? githubRepoIdentityKey(args.prRepo) : '',
    args.sourceHostId ?? LOCAL_EXECUTION_HOST_ID
  ].join('\0')
}

export function retainPRFilesDiffView(viewKey: string): () => void {
  mountedViewCounts.set(viewKey, (mountedViewCounts.get(viewKey) ?? 0) + 1)
  return () => {
    const remaining = (mountedViewCounts.get(viewKey) ?? 1) - 1
    if (remaining > 0) {
      mountedViewCounts.set(viewKey, remaining)
    } else {
      mountedViewCounts.delete(viewKey)
    }
    trimInactivePRDiffBodies()
  }
}

export function rememberPRFilesDiffView(viewKey: string, view: CachedPRFilesDiffViewState): void {
  setWithLRU(prFilesDiffViewStateCache, viewKey, view)
  trimInactivePRDiffBodies()
}

function cachedBodyCharacters(view: CachedPRFilesDiffViewState): number {
  let characters = bodyCharactersBySections.get(view.sections)
  if (characters === undefined) {
    // Read-only PR results mirror the section strings.
    characters = view.sections.reduce(
      (total, section) => total + section.originalContent.length + section.modifiedContent.length,
      0
    )
    bodyCharactersBySections.set(view.sections, characters)
  }
  return characters
}

function trimInactivePRDiffBodies(): void {
  let retainedCharacters = 0
  for (const [viewKey, view] of prFilesDiffViewStateCache) {
    if (!mountedViewCounts.has(viewKey)) {
      retainedCharacters += cachedBodyCharacters(view)
    }
  }
  for (const [viewKey, view] of prFilesDiffViewStateCache) {
    if (retainedCharacters <= MAX_INACTIVE_PR_DIFF_BODY_CHARACTERS) {
      break
    }
    if (mountedViewCounts.has(viewKey)) {
      continue
    }
    const characters = cachedBodyCharacters(view)
    if (characters === 0) {
      continue
    }
    prFilesDiffViewStateCache.set(
      viewKey,
      invalidateCleanSections(
        view,
        (section) => section.originalContent.length > 0 || section.modifiedContent.length > 0
      )
    )
    retainedCharacters -= characters
  }
}
