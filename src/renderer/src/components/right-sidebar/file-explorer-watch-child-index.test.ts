import { describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { DirCache, FileExplorerOperationOwner, TreeNode } from './file-explorer-types'
import { processFileExplorerFsPayload } from './file-explorer-watch-reconcile'

function reconcile(
  cache: Record<string, DirCache>,
  absolutePath: string,
  worktreeId = 'wt-1'
): { dir: ReturnType<typeof vi.fn>; tree: ReturnType<typeof vi.fn> } {
  const dir = vi.fn()
  const tree = vi.fn()
  processFileExplorerFsPayload({
    payload: {
      worktreePath: '/repo',
      events: [{ kind: 'update', absolutePath, isDirectory: false }]
    },
    currentWorktreePath: '/repo',
    worktreeId,
    cache,
    expanded: new Set(),
    setDirCache: vi.fn(),
    setSelectedPath: vi.fn(),
    refreshDir: dir,
    refreshTree: tree
  })
  return { dir, tree }
}

function node(path: string, owner: FileExplorerOperationOwner = { kind: 'local' }): TreeNode {
  return {
    path,
    name: path,
    relativePath: path.slice('/repo/'.length),
    isDirectory: false,
    isSymlink: false,
    depth: 0,
    operationOwner: owner
  }
}

describe('watcher sibling index lifetime', () => {
  it.each([1_000, 10_000])(
    'indexes %i unchanged siblings only once across update payloads',
    (width) => {
      let reads = 0
      const children = Array.from({ length: width }, (_, index) => {
        const path = `/repo/file-${index}.ts`
        const child = node(path)
        Object.defineProperty(child, 'path', {
          get: () => {
            reads++
            return path
          }
        })
        return child
      })
      const cache = { '/repo': { children } }
      for (let payload = 0; payload < 10; payload++) {
        const refresh = reconcile(cache, '/repo/file-0.ts')
        expect(refresh.dir).not.toHaveBeenCalled()
        expect(refresh.tree).not.toHaveBeenCalled()
      }
      expect(reads).toBe(width)
    }
  )

  it('observes listing replacement while reusing an unchanged array through cache copies', () => {
    const children = [node('/repo/old.ts')]
    const before = { '/repo': { children } }
    expect(reconcile(before, '/repo/old.ts').dir).not.toHaveBeenCalled()
    expect(reconcile({ ...before }, '/repo/old.ts').dir).not.toHaveBeenCalled()

    const after = { '/repo': { children: [node('/repo/new.ts')] } }
    expect(reconcile(after, '/repo/new.ts').dir).not.toHaveBeenCalled()
    expect(reconcile(after, '/repo/old.ts').dir).toHaveBeenCalledWith('/repo')
  })

  it('keeps same-path inventories independent for folder workspaces on different hosts', () => {
    const local = { '/repo': { children: [node('/repo/local.ts')] } }
    const remote = {
      '/repo': {
        children: [node('/repo/remote.ts', { kind: 'ssh', connectionId: 'box' })]
      }
    }
    const folder = folderWorkspaceKey('folder')
    expect(reconcile(local, '/repo/local.ts', folder).dir).not.toHaveBeenCalled()
    expect(reconcile(remote, '/repo/local.ts', folder).dir).toHaveBeenCalledWith('/repo')
    expect(reconcile(remote, '/repo/remote.ts', folder).dir).not.toHaveBeenCalled()
  })

  it('releases retired listing arrays and their indexed child nodes', async () => {
    if (typeof globalThis.gc !== 'function') {
      throw new Error('Run with the repository Vitest --expose-gc config')
    }
    function retireListing(): { array: WeakRef<TreeNode[]>; child: WeakRef<TreeNode> } {
      const child = node('/repo/retired.ts')
      const children = [child]
      reconcile({ '/repo': { children } }, child.path)
      return { array: new WeakRef(children), child: new WeakRef(child) }
    }
    const retired = retireListing()
    for (let round = 0; round < 8; round++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      globalThis.gc()
    }
    expect(retired.array.deref() === undefined).toBe(true)
    expect(retired.child.deref() === undefined).toBe(true)
  })
})
