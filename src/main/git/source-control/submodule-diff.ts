import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { buildDiffResult } from './diff-result'
import { assertReadableGitBlobs, readGitBlobAtOidPath } from './git-blob-read'
import { resolveSubmoduleWorktreePath } from './submodule-paths'
import {
  readGitlinkOidFromIndex,
  readGitlinkOidFromTree,
  readWorkingSubmoduleHead
} from './submodule-gitlink-oid'

export function submodulePointerContent(oid: string): string {
  return oid ? `Subproject commit ${oid}\n` : ''
}

/** Feed gitlink OIDs to the text differ as Subproject commit lines. */
export async function buildSubmodulePointerDiff(
  worktreePath: string,
  submodulePath: string,
  staged: boolean,
  compareAgainstHead: boolean,
  options: GitRuntimeOptions,
  // Default to the validated resolver to prevent submodule path escape.
  submoduleWorktreePath = resolveSubmoduleWorktreePath(worktreePath, submodulePath)
): Promise<GitDiffResult> {
  let leftOid = ''
  let rightOid = ''
  if (staged) {
    leftOid = await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options)
    rightOid = await readGitlinkOidFromIndex(worktreePath, submodulePath, options)
  } else if (compareAgainstHead) {
    leftOid = await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options)
    rightOid = await readWorkingSubmoduleHead(submoduleWorktreePath, options)
  } else {
    leftOid =
      (await readGitlinkOidFromIndex(worktreePath, submodulePath, options)) ||
      (await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options))
    rightOid = await readWorkingSubmoduleHead(submoduleWorktreePath, options)
  }
  return buildDiffResult(
    submodulePointerContent(leftOid),
    submodulePointerContent(rightOid),
    false,
    false,
    submodulePath
  )
}

/** Show committed inner-file changes when a clean submodule's gitlink moved. */
export async function buildSubmoduleInnerCommitRangeDiff(
  submoduleWorktreePath: string,
  innerPath: string,
  fromOid: string,
  toOid: string,
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  const left = await readGitBlobAtOidPath(submoduleWorktreePath, fromOid, innerPath, options)
  const right = await readGitBlobAtOidPath(submoduleWorktreePath, toOid, innerPath, options)
  assertReadableGitBlobs(innerPath, left, right)
  return buildDiffResult(
    left.content,
    right.content,
    left.isBinary,
    right.isBinary,
    innerPath,
    left.tooLarge === true || right.tooLarge === true
  )
}
