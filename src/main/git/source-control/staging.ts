import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'
import { literalPathspec } from './git-pathspec'
import { encodeGitPathspecs } from '../../../shared/git-pathspec-stdin'
import type { ConflictResolution } from '../../../shared/source-control-entry-actions'
import {
  stageGitWorktreeScope,
  type GitStageWorktreeScope,
  type GitStageWorktreeScopeReceipt
} from '../../../shared/git-stage-worktree-scope'
import { findExistingWorktreeSymlinkPaths } from '../worktree-symlink-detection'
import { redoWriteForDriveCheckoutSuspects } from './drive-checkout-suspect-writes'

const STAGE_WRITE = ['add', '--update'] as const

export async function stageFile(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  try {
    await gitExecFileAsync(
      ['add', '--', literalPathspec(filePath, worktreePath, options)],
      gitOptionsForWorktree(worktreePath, options)
    )
    await redoWriteForDriveCheckoutSuspects(worktreePath, [filePath], STAGE_WRITE, options)
  } finally {
    invalidateGitReadCaches()
  }
}

/** Git's own resolution: add keeps the worktree file; rm records the deletion and removes any leftover copy. */
export async function resolveConflict(
  worktreePath: string,
  filePath: string,
  resolution: ConflictResolution,
  options: GitRuntimeOptions = {}
): Promise<void> {
  const pathspec = literalPathspec(filePath, worktreePath, options)
  // A stale row (phone poll, another client) must not overwrite a resolution someone already staged.
  const { stdout: unmerged } = await gitExecFileAsync(
    ['ls-files', '--unmerged', '-z', '--', pathspec],
    gitOptionsForWorktree(worktreePath, options)
  )
  if (!unmerged) {
    throw new Error(`${filePath} is no longer in conflict. Refresh to see its current state.`)
  }
  if (resolution !== 'keep_deletion') {
    await stageFile(worktreePath, filePath, options)
    return
  }
  invalidateGitReadCaches()
  try {
    await gitExecFileAsync(
      ['rm', '--force', '--quiet', '--', pathspec],
      gitOptionsForWorktree(worktreePath, options)
    )
  } finally {
    invalidateGitReadCaches()
  }
}

export async function unstageFile(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  try {
    // Reset treats an unborn HEAD as an empty tree, preserving the working file.
    await gitExecFileAsync(
      ['reset', '--quiet', '--', literalPathspec(filePath, worktreePath, options)],
      {
        ...gitOptionsForWorktree(worktreePath, options)
      }
    )
  } finally {
    invalidateGitReadCaches()
  }
}

// Use stdin to avoid argv limits and repeated index writes.
export async function bulkStageFiles(
  worktreePath: string,
  filePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  if (filePaths.length === 0) {
    return
  }
  try {
    await gitExecFileAsync(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      ...gitOptionsForWorktree(worktreePath, options),
      stdin: encodeGitPathspecs(
        filePaths.map((filePath) => literalPathspec(filePath, worktreePath, options))
      )
    })
    await redoWriteForDriveCheckoutSuspects(worktreePath, filePaths, STAGE_WRITE, options)
  } finally {
    invalidateGitReadCaches()
  }
}

// A capped status listing cannot enumerate every change for Stage All.
export async function stageWorktreeChanges(
  worktreePath: string,
  scope: GitStageWorktreeScope,
  options: GitRuntimeOptions & { sharedLinkPaths?: readonly string[] } = {}
): Promise<GitStageWorktreeScopeReceipt> {
  invalidateGitReadCaches()
  try {
    const gitOptions = gitOptionsForWorktree(worktreePath, options)
    // Directory-only ignore rules do not hide shared symlinks; exclude them from add --all.
    const excludedUntrackedPaths =
      scope === 'all' && options.sharedLinkPaths && options.sharedLinkPaths.length > 0
        ? await findExistingWorktreeSymlinkPaths(worktreePath, options.sharedLinkPaths, {
            wslDistro: options.wslDistro
          })
        : []
    const receipt = await stageGitWorktreeScope(
      scope,
      (args, stdin) =>
        gitExecFileAsync(args, stdin === undefined ? gitOptions : { ...gitOptions, stdin }),
      { excludedUntrackedPaths }
    )
    await redoWriteForDriveCheckoutSuspects(worktreePath, ['.'], STAGE_WRITE, options)
    return receipt
  } finally {
    invalidateGitReadCaches()
  }
}

// Use stdin to avoid argv limits and repeated index writes.
export async function bulkUnstageFiles(
  worktreePath: string,
  filePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  if (filePaths.length === 0) {
    return
  }
  try {
    await gitExecFileAsync(['reset', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      ...gitOptionsForWorktree(worktreePath, options),
      stdin: encodeGitPathspecs(
        filePaths.map((filePath) => literalPathspec(filePath, worktreePath, options))
      )
    })
  } finally {
    invalidateGitReadCaches()
  }
}
