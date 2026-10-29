import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import { stableInFlightKey } from '../../../shared/in-flight-promise-dedupe'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitRuntimeOptionsKey } from './git-runtime-options-cache-key'
import { gitDiffReadDedupe } from './git-read-cache-invalidation'
import { buildDiffResult } from './diff-result'
import { assertReadableGitBlobs } from './git-blob-read'
import { readHistoricalDiffSide } from './historical-diff-side'

export async function getBranchDiff(
  worktreePath: string,
  args: {
    headOid: string
    mergeBase: string
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions = {}
): Promise<GitDiffResult> {
  return gitDiffReadDedupe.run(
    stableInFlightKey([
      'branchDiff',
      worktreePath,
      args.headOid,
      args.mergeBase,
      args.filePath,
      args.oldPath ?? null,
      ...gitRuntimeOptionsKey(options)
    ]),
    () => loadBranchDiff(worktreePath, args, options)
  )
}

async function loadBranchDiff(
  worktreePath: string,
  args: {
    headOid: string
    mergeBase: string
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  const leftPath = args.oldPath ?? args.filePath
  const [leftBlob, rightBlob] = await Promise.all([
    readHistoricalDiffSide(worktreePath, args.mergeBase, leftPath, options),
    readHistoricalDiffSide(worktreePath, args.headOid, args.filePath, options)
  ])

  assertReadableGitBlobs(args.filePath, leftBlob, rightBlob)
  return buildDiffResult(
    leftBlob.content,
    rightBlob.content,
    leftBlob.isBinary,
    rightBlob.isBinary,
    args.filePath,
    leftBlob.tooLarge === true || rightBlob.tooLarge === true
  )
}
