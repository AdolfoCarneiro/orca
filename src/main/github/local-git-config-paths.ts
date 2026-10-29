import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

type LocalGitConfigPaths = {
  commonConfigPath: string
  worktreeConfigPath: string
}

export async function resolveLocalGitConfigPaths(
  repoPath: string
): Promise<LocalGitConfigPaths | null> {
  const dotGitPath = join(repoPath, '.git')
  try {
    const dotGitStats = await stat(dotGitPath)
    if (dotGitStats.isDirectory()) {
      return {
        commonConfigPath: join(dotGitPath, 'config'),
        worktreeConfigPath: join(dotGitPath, 'config.worktree')
      }
    }
    if (!dotGitStats.isFile()) {
      return null
    }
  } catch {
    return null
  }

  try {
    const gitFile = await readFile(dotGitPath, 'utf8')
    const match = gitFile.match(/^gitdir:\s*(.+?)\s*$/im)
    if (!match) {
      return null
    }
    const gitDir = resolve(dirname(dotGitPath), match[1])
    let commonGitDir = gitDir
    try {
      const commonDir = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
      if (commonDir) {
        commonGitDir = resolve(gitDir, commonDir)
      }
    } catch {
      // Try the linked-worktree gitdir instead.
    }
    return {
      commonConfigPath: join(commonGitDir, 'config'),
      worktreeConfigPath: join(gitDir, 'config.worktree')
    }
  } catch {
    return null
  }
}
