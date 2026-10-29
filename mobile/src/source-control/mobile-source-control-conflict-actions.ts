import type { ConflictResolution } from '../../../src/shared/source-control-entry-actions'

export const MOBILE_COMPLETE_MERGE_ACTION_ID = 'complete-merge'

export const MOBILE_CONFLICT_NEEDS_NEWER_HOST_MESSAGE =
  'Update Orca on the computer running this workspace to resolve merge conflicts from your phone.'

export const MOBILE_CONFLICT_RESOLUTION_LABELS: Record<ConflictResolution, string> = {
  mark_resolved: 'Mark as resolved',
  keep_file: 'Keep file',
  keep_deletion: 'Keep deletion'
}
