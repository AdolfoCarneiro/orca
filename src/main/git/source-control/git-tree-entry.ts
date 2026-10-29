import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import { literalPathspec } from './git-pathspec'

type GitTreeEntry = {
  mode: string
  objectType: 'blob' | 'commit' | 'tree'
  oid: string
}

export async function readGitTreeEntryAtPath(
  worktreePath: string,
  ref: string,
  filePath: string,
  options: GitRuntimeOptions
): Promise<GitTreeEntry | null> {
  if (!ref || ref.startsWith('-')) {
    throw new Error('Invalid commit diff tree reference')
  }
  const { stdout } = await gitExecFileAsync(
    ['ls-tree', '-z', ref, '--', literalPathspec(filePath, worktreePath, options)],
    {
      ...gitOptionsForWorktree(worktreePath, options),
      captureWslLoginShellOutput: true,
      env: gitOptionalLocksDisabledEnv()
    }
  )
  if (!stdout) {
    return null
  }
  const match = /^([0-7]{6}) (blob|commit|tree) ([0-9a-f]{40}|[0-9a-f]{64})\t[^\0]*\0$/.exec(stdout)
  const mode = match?.[1]
  const objectType = match?.[2]
  const oid = match?.[3]
  if (
    !mode ||
    !oid ||
    (objectType !== 'blob' && objectType !== 'commit' && objectType !== 'tree')
  ) {
    throw new Error('Invalid commit diff tree entry')
  }
  return { mode, objectType, oid }
}
