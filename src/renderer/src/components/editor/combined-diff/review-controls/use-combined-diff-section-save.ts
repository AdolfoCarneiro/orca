import { useCallback, useLayoutEffect, useRef } from 'react'
import type React from 'react'
import { useAppStore } from '@/store'
import { joinPath } from '@/lib/path'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { getDiskBaselineSignature } from '../../../../../../shared/disk-baseline-signature'
import { writeEditorSave } from '../../editor-save-disk-precondition'
import { withEditorFileWriteLock } from '../../editor-file-write-lock'
import { editorPathHoldKey } from '../../editor-autosave-holds'
import type { OpenFile } from '@/store/slices/editor'
import { getLargeDiffRenderLimit } from '../../large-diff-render-limit'
import { getStoredTextDiffContent, getStoredTextDiffResult, isPrunedTextDiffResult } from '../../large-diff-section-content'
import { removeDiffSectionMeasuredHeight } from '../../diff-section-height-cache'
import type { DiffSection } from '../../diff-section-types'
import type { DiffSectionItemProps } from '../../diff-section-item-props'

function acknowledgeSectionSave(section: DiffSection, content: string): DiffSection {
  if (section.modifiedContent !== content) {
    // The saved text is the new disk baseline; a later draft still belongs to the user.
    return {
      ...section,
      dirty: true,
      saveConflict: undefined,
      diffResult:
        section.diffResult?.kind === 'text'
          ? { ...section.diffResult, modifiedContent: content }
          : section.diffResult
    }
  }
  if (section.diffResult?.kind !== 'text') {
    return { ...section, dirty: false, saveConflict: undefined }
  }
  const diffResult = { ...section.diffResult, modifiedContent: content }
  const renderLimit = getLargeDiffRenderLimit({
    originalContent: section.originalContent,
    modifiedContent: content
  })
  return {
    ...section,
    ...getStoredTextDiffContent(diffResult, renderLimit),
    dirty: false,
    saveConflict: undefined,
    diffResult: getStoredTextDiffResult(diffResult, renderLimit),
    largeDiffRenderLimit: renderLimit
  }
}

export function useCombinedDiffSectionSave({
  file,
  retryDeferredSectionReloadRef,
  sectionsRef,
  setSectionHeights,
  setSections
}: {
  file: OpenFile
  retryDeferredSectionReloadRef: React.RefObject<(index: number) => void>
  sectionsRef: React.RefObject<DiffSection[]>
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
}): DiffSectionItemProps['handleSectionSaveRef'] {
  const savesRef = useRef(new Map<string, Promise<void>>())
  const writtenBySectionRef = useRef(new Map<string, string>())
  const saveSection = useCallback(
    (index: number, mode?: 'overwrite'): Promise<void> => {
      const requested = sectionsRef.current[index]
      if (!requested?.dirty) {
        return Promise.resolve()
      }
      const key = requested.key
      const generation = requested.contentGeneration
      const saves = savesRef.current
      const previous = saves.get(key) ?? Promise.resolve()
      const queued = previous
        .catch(() => undefined)
        .then(async () => {
          // Resolve by identity after earlier writes finish; ordering and drafts may have changed.
          const section = sectionsRef.current.find((entry) => entry.key === key)
          if (!section?.dirty || section.contentGeneration !== generation) {
            return
          }
          const content = section.modifiedContent
          const loaded = writtenBySectionRef.current.get(key) ??
            (section.diffResult?.kind === 'text' && !isPrunedTextDiffResult(section.diffResult)
              ? section.diffResult.modifiedContent
              : undefined)
          const markConflict = (): void => setSections((prev) =>
            prev.map((entry) => entry.key === key && entry.contentGeneration === generation
              ? { ...entry, saveConflict: true }
              : entry))
          if (loaded === undefined && mode !== 'overwrite') {
            markConflict()
            return
          }
          const state = useAppStore.getState()
          const worktree = file.worktreeId
            ? findWorktreeById(selectWorktreesByRepo(state), file.worktreeId)
            : null
          const absolutePath = joinPath(file.filePath, section.path)
          const context = getEditorFileOperationContext(state, file, worktree?.path ?? null)
          const written = await withEditorFileWriteLock(
            editorPathHoldKey(state, file, absolutePath),
            () => writeEditorSave(context, absolutePath, content, undefined,
              mode === 'overwrite' || loaded === undefined
                ? { kind: 'explicit-overwrite' }
                : { kind: 'guarded', signature: getDiskBaselineSignature(loaded), allowMissing: false })
          )
          if (!written.ok) {
            markConflict()
            return
          }
          writtenBySectionRef.current.set(key, content)
          const savedIndex = sectionsRef.current.findIndex(
            (entry) => entry.key === key && entry.contentGeneration === generation
          )
          if (savedIndex === -1) {
            return
          }
          setSectionHeights((prev) => removeDiffSectionMeasuredHeight(prev, savedIndex))
          setSections((prev) =>
            prev.map((entry) =>
              entry.key === key && entry.contentGeneration === generation
                ? acknowledgeSectionSave(entry, content)
                : entry
            )
          )
          // Why: a revalidation rejected while this row was dirty left the original side stale,
          // and the git-status signature does not change for an edit inside an already-modified
          // line, so nothing else re-drives it. The row is clean now, so the reload can proceed.
          // No-ops unless this row actually refused one, so a plain save costs no extra git diff.
          retryDeferredSectionReloadRef.current(savedIndex)
        })
        .catch((error: unknown) => {
          console.error('Save failed:', error)
        })
      const tracked = queued.finally(() => {
        if (saves.get(key) === tracked) {
          saves.delete(key)
          writtenBySectionRef.current.delete(key)
        }
      })
      saves.set(key, tracked)
      return tracked
    },
    [file, retryDeferredSectionReloadRef, sectionsRef, setSectionHeights, setSections]
  )
  const saveRef = useRef(saveSection)
  useLayoutEffect(() => {
    saveRef.current = saveSection
  }, [saveSection])
  return saveRef
}
