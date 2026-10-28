export function orderMainWorktreeFirst<T extends { isMainWorktree?: boolean }>(
  worktrees: T[]
): T[] {
  const mainWorktrees = worktrees.filter((worktree) => worktree.isMainWorktree)
  if (mainWorktrees.length === 0) {
    return worktrees
  }
  // Keep canonical workspaces first for repo-scanned project groups despite dynamic child ranking.
  return [...mainWorktrees, ...worktrees.filter((worktree) => !worktree.isMainWorktree)]
}
