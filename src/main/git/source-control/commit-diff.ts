import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import { stableInFlightKey } from '../../../shared/in-flight-promise-dedupe'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitRuntimeOptionsKey } from './git-runtime-options-cache-key'
import { gitDiffReadDedupe } from './git-read-cache-invalidation'
import { buildDiffResult } from './diff-result'
import { assertReadableGitBlobs, type GitBlobReadResult } from './git-blob-read'
import { readHistoricalDiffSide } from './historical-diff-side'

export async function getCommitDiff(
  worktreePath: string,
  args: {
    commitOid: string
    parentOid?: string | null
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions = {}
): Promise<GitDiffResult> {
  return gitDiffReadDedupe.run(
    stableInFlightKey([
      'commitDiff',
      worktreePath,
      args.commitOid,
      args.parentOid ?? null,
      args.filePath,
      args.oldPath ?? null,
      ...gitRuntimeOptionsKey(options)
    ]),
    () => loadCommitDiff(worktreePath, args, options)
  )
}

async function loadCommitDiff(
  worktreePath: string,
  args: {
    commitOid: string
    parentOid?: string | null
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  const leftPath = args.oldPath ?? args.filePath
  const [leftBlob, rightBlob] = await Promise.all([
    args.parentOid
      ? readHistoricalDiffSide(worktreePath, args.parentOid, leftPath, options)
      : Promise.resolve<GitBlobReadResult>({ content: '', isBinary: false, exists: false }),
    readHistoricalDiffSide(worktreePath, args.commitOid, args.filePath, options)
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
