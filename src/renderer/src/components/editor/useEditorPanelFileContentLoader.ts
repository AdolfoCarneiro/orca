import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { readEditorPanelFileContent } from './editor-panel-file-reads'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile, isWorktreeConnectionResolved } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { getRuntimeFileReadScope } from '@/runtime/runtime-file-routing'
import { readEditorCsvFileContent } from './csv/csv-file-content'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { requireRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { findWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import {
  WORKTREE_OWNER_NOT_READY_ERROR,
  type EditorPanelFileContentLoader,
  type UseEditorPanelFileContentLoaderParams
} from './editor-panel-content-types'
import type { EditorPanelContentLoadOptions } from './useEditorPanelExternalContentEvents'
import {
  migrateRestoredEditorFileOwner,
  restoredOwnerMigrationErrorMessage
} from './migrate-restored-editor-file-owner'
import { findRestoredEditorWorkspaceRuntimeOwner } from './restored-editor-workspace-runtime-owner'
import type { RuntimeWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { editorTabFileAccess, isClientLocalReadOnlyTab } from '@/lib/local-file-access'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { grantRestoredHostFile } from './restored-host-file-grant'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import { chatScratchFileAddress } from '@/runtime/runtime-chat-scratch-file-address'
import { stampCleanTabDiskBaseline } from './editor-clean-tab-disk-baseline'
import {
  applyEditorFileLoadFailure,
  getEditorFileLoadFailureContent
} from './editor-deleted-file-reload'
export type { EditorPanelFileContentLoader } from './editor-panel-content-types'
import {
  acquireEditorFileOperation,
  isSameEditorFileOperationIdentity
} from '@/lib/editor-file-operation-owner'

function inFlightReadKey(connectionId: string | undefined, filePath: string): string {
  return `${connectionId ?? ''}::${filePath}`
}

export function useEditorPanelFileContentLoader({
  fileLoadRetryAttemptsRef,
  fileReadGenerationCounterRef,
  fileReadGenerationRef,
  openFilesRef,
  outstandingFileReadsRef,
  setFileContents
}: UseEditorPanelFileContentLoaderParams): EditorPanelFileContentLoader {
  return useCallback(
    async (
      filePath: string,
      id: string,
      worktreeId?: string,
      relativePath?: string,
      options?: EditorPanelContentLoadOptions
    ): Promise<void> => {
      const generation = fileReadGenerationCounterRef.current + 1
      fileReadGenerationCounterRef.current = generation
      fileReadGenerationRef.current[id] = generation
      outstandingFileReadsRef.current[id] = generation
      let readConnectionId: string | undefined
      let acquisition: ReturnType<typeof acquireEditorFileOperation> | null = null
      let requestedFile: OpenFile | undefined
      let requiredLive = false
      const matchesRequest = (file: OpenFile): boolean =>
        file.filePath === filePath &&
        (worktreeId === undefined || file.worktreeId === worktreeId) &&
        (relativePath === undefined || file.relativePath === relativePath)
      const requestCurrent = (): boolean => {
        if (fileReadGenerationRef.current[id] !== generation) {
          return false
        }
        const live = useAppStore.getState().openFiles.find((file) => file.id === id)
        if ((live && !matchesRequest(live)) || (requiredLive && !live)) {
          return false
        }
        if (requestedFile && live && !isSameEditorFileOperationIdentity(requestedFile, live)) {
          return false
        }
        try {
          acquisition?.assertCurrent()
          return true
        } catch {
          return false
        }
      }
      try {
        const resolvedConnectionId = getConnectionIdForFile(worktreeId ?? null, filePath)
        const connectionId = resolvedConnectionId ?? undefined
        const liveAtStart = useAppStore.getState().openFiles.find((file) => file.id === id)
        const restoredOpenFile = liveAtStart ?? openFilesRef.current.find((file) => file.id === id)
        requestedFile = restoredOpenFile
        requiredLive = liveAtStart !== undefined
        if (restoredOpenFile && restoredOpenFile.filePath !== filePath) {
          return
        }
        const isLiveTailLogTab =
          restoredOpenFile?.readOnly === true && restoredOpenFile.liveTail === true
        // Client-local tabs must not inherit workspace SSH/runtime ownership; explicit stamps still route.
        const isClientLocalTab = restoredOpenFile
          ? isClientLocalReadOnlyTab(restoredOpenFile)
          : false
        let readTarget: RuntimeClientTarget =
          isClientLocalTab && restoredOpenFile?.runtimeEnvironmentId === undefined
            ? { kind: 'local' }
            : requireRuntimeTargetForFileOwner(
                useAppStore.getState(),
                worktreeId,
                restoredOpenFile?.runtimeEnvironmentId
              )
        const readOwnerEnvironmentId =
          readTarget.kind === 'environment' ? readTarget.environmentId : undefined
        readConnectionId = connectionId
        let readWorktreeId = worktreeId
        let readGrantId = restoredOpenFile?.terminalArtifactGrantId
        let readGrantPairing: number | undefined
        let readRelativePath = restoredOpenFile?.relativePath ?? relativePath
        // Re-owning re-keys the tab, which starts a fresh load under the new owner.
        const reownRestoredFile = async (
          route: RuntimeWorkspaceFileRoute,
          runtimeEnvironmentId: string | null
        ): Promise<void> => {
          const migration = await migrateRestoredEditorFileOwner(id, route, runtimeEnvironmentId)
          if (!migration.ok) {
            throw new Error(restoredOwnerMigrationErrorMessage(migration.reason))
          }
          fileReadGenerationRef.current[id] = ++fileReadGenerationCounterRef.current
          setFileContents((prev) => {
            const next = { ...prev }
            delete next[id]
            return next
          })
        }
        const workspaceRuntimeOwner =
          restoredOpenFile && !isClientLocalTab
            ? findRestoredEditorWorkspaceRuntimeOwner(
                useAppStore.getState(),
                restoredOpenFile,
                worktreeId
              )
            : null
        if (workspaceRuntimeOwner) {
          await reownRestoredFile(
            workspaceRuntimeOwner.route,
            workspaceRuntimeOwner.runtimeEnvironmentId
          )
          return
        }
        if (
          !isClientLocalTab &&
          resolvedConnectionId === undefined &&
          !readOwnerEnvironmentId &&
          !isWorktreeConnectionResolved(worktreeId ?? null)
        ) {
          // Unhydrated owners may be remote; fail retryably rather than turning a bad client-local read into terminal access denial.
          throw new Error(WORKTREE_OWNER_NOT_READY_ERROR)
        }
        if (restoredOpenFile?.filePath === filePath && restoredOpenFile.relativePath === filePath) {
          // Absolute paths in SSH workspaces belong to their resolved host, including legacy tabs without terminal-link stamps.
          const externalSshOwnerId =
            restoredOpenFile.externalSshTargetId?.trim() ||
            (isClientLocalTab ? undefined : connectionId)
          const runtimeEnvironmentId = isClientLocalTab ? undefined : readOwnerEnvironmentId
          if (isClientLocalTab) {
            readConnectionId = undefined
          } else {
            const currentState = useAppStore.getState()
            const executionHostId = externalSshOwnerId
              ? toSshExecutionHostId(externalSshOwnerId)
              : runtimeEnvironmentId
                ? toRuntimeExecutionHostId(runtimeEnvironmentId)
                : LOCAL_EXECUTION_HOST_ID
            // Floating files stay in their panel even when a project also contains the path.
            const route = isFloatingWorkspaceId(worktreeId)
              ? null
              : findWorkspaceFileRoute(currentState, executionHostId, filePath)
            if (route && route.worktreeId !== worktreeId) {
              await reownRestoredFile(route, runtimeEnvironmentId ?? null)
              return
            }
            if (
              runtimeEnvironmentId &&
              !route &&
              !readGrantId &&
              !chatScratchFileAddress(filePath)
            ) {
              readGrantPairing =
                readTarget.kind === 'environment'
                  ? captureRuntimeEnvironmentRequestRevision(readTarget.environmentId)
                  : undefined
              const restored = await grantRestoredHostFile(
                readTarget,
                readWorktreeId,
                filePath,
                readGrantPairing
              )
              readGrantId = restored.grantId
              // Why: a read-only grant stays off the tab, so its save asks the host again and is refused.
              if (!restored.readOnly) {
                useAppStore.getState().setTerminalArtifactGrant(id, readGrantId)
              }
            }
            if (!externalSshOwnerId) {
              // Client-local external tabs must stay off the workspace’s SSH host.
              readConnectionId = undefined
            }
          }
        }
        if (restoredOpenFile && !matchesRequest(restoredOpenFile)) {
          return
        }
        acquisition =
          liveAtStart && !isClientLocalTab
            ? acquireEditorFileOperation(useAppStore.getState, liveAtStart)
            : null
        if (acquisition) {
          readTarget = acquisition.context.target
          readConnectionId = acquisition.context.connectionId
        }
        const readScope = getRuntimeFileReadScope(readTarget, readConnectionId)
        const access = restoredOpenFile
          ? editorTabFileAccess(useAppStore.getState(), restoredOpenFile)
          : undefined
        const allowPagedPreview =
          !restoredOpenFile?.isDirty &&
          (!/\.(csv|tsv)$/i.test(filePath) || useAppStore.getState().editorDrafts[id] === undefined)
        // Keep file authorization and editable drafts isolated between concurrent reads.
        const key = `${inFlightReadKey(readScope, filePath)}::${JSON.stringify(acquisition?.file.operationProvenance)}::${access?.kind ?? ''}${allowPagedPreview ? '' : '::editable'}${options?.wakeWslDistro ? '::wake' : ''}`
        const result = await readEditorPanelFileContent(key, options, () =>
          readEditorCsvFileContent(
            {
              target: readTarget,
              filePath,
              relativePath: readRelativePath,
              worktreeId: readWorktreeId,
              connectionId: readConnectionId,
              expectedExternalSshTargetId: restoredOpenFile?.externalSshTargetId,
              includeLocalLogMetadata: isLiveTailLogTab,
              access,
              terminalArtifactGrantId: readGrantId,
              expectedEnvironmentPairingRevision: readGrantPairing,
              pageOversizedBinary: true,
              ...(options?.wakeWslDistro ? { wakeWslDistro: true } : {})
            },
            allowPagedPreview
          )
        )
        if (!requestCurrent()) {
          return
        }
        acquisition?.assertCurrent()
        if (result.csvPreview && useAppStore.getState().editorDrafts[id] !== undefined) {
          throw new Error(
            translate(
              'auto.components.editor.EditorPanel.csvGrewTooLarge',
              'CSV grew too large for editing. Your draft has been kept; reopen the file to preview it.'
            )
          )
        }
        if (result.csvPreview || restoredOpenFile?.csvPreviewOnly) {
          useAppStore.getState().setCsvPreviewOnly(id, Boolean(result.csvPreview))
        }
        delete fileLoadRetryAttemptsRef.current[id]
        setFileContents((prev) => (requestCurrent() ? { ...prev, [id]: result } : prev))
        stampCleanTabDiskBaseline(id, result)
      } catch (err) {
        if (!requestCurrent()) {
          return
        }
        const failure = getEditorFileLoadFailureContent(
          useAppStore.getState(),
          worktreeId,
          readConnectionId,
          err
        )
        applyEditorFileLoadFailure({
          error: err,
          fileId: id,
          filePath,
          tabs: openFilesRef.current,
          failure,
          setFileContents: (update) =>
            setFileContents((prev) =>
              requestCurrent() ? (typeof update === 'function' ? update(prev) : update) : prev
            )
        })
      } finally {
        if (outstandingFileReadsRef.current[id] === generation) {
          delete outstandingFileReadsRef.current[id]
        }
      }
    },
    [
      fileLoadRetryAttemptsRef,
      fileReadGenerationCounterRef,
      fileReadGenerationRef,
      openFilesRef,
      outstandingFileReadsRef,
      setFileContents
    ]
  )
}
