export type PendingDiffCommentDraftSubmission = { finish: ((succeeded: boolean) => void) | null }

export async function finishDiffCommentDraftZoneSubmission(
  save: Promise<boolean>,
  submission: PendingDiffCommentDraftSubmission,
  pending: Set<PendingDiffCommentDraftSubmission>
): Promise<boolean> {
  let succeeded = false
  try {
    const result = await save
    succeeded = result !== false
    return result
  } finally {
    completeDiffCommentDraftZoneSubmission(submission, pending, succeeded)
  }
}

export function completeDiffCommentDraftZoneSubmission(
  submission: PendingDiffCommentDraftSubmission,
  pending: Set<PendingDiffCommentDraftSubmission>,
  succeeded: boolean
): void {
  const finish = submission.finish
  submission.finish = null
  pending.delete(submission)
  finish?.(succeeded)
}
