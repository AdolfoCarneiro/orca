import type { GitRuntimeOptions } from '../git-runtime-options'
import { readGitBlobByObjectOid, type GitBlobReadResult } from './git-blob-read'
import { readGitTreeEntryAtPath } from './git-tree-entry'
import { submodulePointerContent } from './submodule-diff'

export async function readHistoricalDiffSide(
  worktreePath: string,
  ref: string,
  filePath: string,
  options: GitRuntimeOptions
): Promise<GitBlobReadResult> {
  const entry = await readGitTreeEntryAtPath(worktreePath, ref, filePath, options)
  if (!entry) {
    return { content: '', isBinary: false, exists: false }
  }
  if (entry.mode === '160000' && entry.objectType === 'commit') {
    return { content: submodulePointerContent(entry.oid), isBinary: false, exists: true }
  }
  if (entry.objectType !== 'blob') {
    throw new Error(`Could not read the complete diff for "${filePath}".`)
  }
  return readGitBlobByObjectOid(worktreePath, entry.oid, filePath, options)
}
