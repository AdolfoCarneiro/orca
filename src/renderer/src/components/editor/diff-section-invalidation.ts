import type { DiffSection } from './diff-section-types'

type DiffSectionView = {
  sections: DiffSection[]
  loadedIndices: number[]
}

// Invalidate clean sections only; dirty cached edits survive until their guarded save or conflict action handles disk changes.
export function invalidateCleanSections<View extends DiffSectionView>(
  view: View,
  isStale: (section: DiffSection) => boolean
): View {
  let changed = false
  const sections = view.sections.map((section) => {
    if (
      section.dirty ||
      section.saveConflict ||
      section.loading ||
      section.loadOnDemand === true ||
      !isStale(section)
    ) {
      return section
    }
    changed = true
    return {
      ...section,
      originalContent: '',
      modifiedContent: '',
      loading: true,
      error: undefined,
      diffResult: null,
      largeDiffRenderLimit: null,
      contentGeneration: (section.contentGeneration ?? 0) + 1
    }
  })
  if (!changed) {
    return view
  }
  return {
    ...view,
    sections,
    loadedIndices: view.loadedIndices.filter((index) => sections[index] === view.sections[index])
  }
}
