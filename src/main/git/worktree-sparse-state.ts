import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseGitConfigFlag } from './git-config-boolean'
import type { GitRuntimeOptions } from './git-runtime-options'
import { resolveGitDir } from './status'

export async function detectSparseCheckout(
  worktreePath: string,
  // WSL writes guest-spelled gitdir pointers that require the caller's distro for Windows I/O.
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<boolean> {
  // Filesystem probes avoid a Git subprocess per worktree on each poll.
  try {
    const gitDir = await resolveGitDir(worktreePath, options)
    const stats = await stat(join(gitDir, 'info', 'sparse-checkout'))
    if (!stats.isFile() || stats.size === 0) {
      return false
    }
    // Disable retains the pattern file; confirm core.sparseCheckout through direct config reads.
    return await isSparseCheckoutEnabled(gitDir)
  } catch {
    return false
  }
}

/** Linked gitdirs point to the shared common dir; missing/unreadable pointers fall back to this gitdir. */
export async function resolveGitCommonDir(gitDir: string): Promise<string> {
  try {
    const raw = (await readFile(join(gitDir, 'commondir'), 'utf-8')).trim()
    if (raw.length > 0) {
      return isAbsolute(raw) ? raw : resolve(gitDir, raw)
    }
  } catch {
    // Best effort: no readable commondir pointer.
  }
  return gitDir
}

// Worktree config overrides shared config only while extensions.worktreeConfig is enabled.
async function isSparseCheckoutEnabled(gitDir: string): Promise<boolean> {
  const commonDir = await resolveGitCommonDir(gitDir)
  const sharedConfig = await readGitConfigText(join(commonDir, 'config'))
  const sharedFlag = parseCoreSparseCheckoutFlag(sharedConfig)
  // Stale worktree config must not override a disabled extensions.worktreeConfig setting.
  if (parseGitConfigFlag(sharedConfig, 'extensions', 'worktreeconfig') !== true) {
    return sharedFlag ?? false
  }
  const worktreeConfig = await readGitConfigText(join(gitDir, 'config.worktree'))
  return parseCoreSparseCheckoutFlag(worktreeConfig) ?? sharedFlag ?? false
}

async function readGitConfigText(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, 'utf-8')
  } catch {
    return ''
  }
}

export function parseCoreSparseCheckoutFlag(configContent: string): boolean | undefined {
  return parseGitConfigFlag(configContent, 'core', 'sparsecheckout')
}
