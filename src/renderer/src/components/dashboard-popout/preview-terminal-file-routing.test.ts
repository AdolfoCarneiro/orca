import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewTerminalLinkContext } from './preview-terminal-link-context'
import { handleOscLink } from '@/components/terminal-pane/terminal-osc-link-routing'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import type { TerminalLinkActionRequest } from '@/components/terminal-pane/terminal-link-action-request'
import type { FileOpenFailure } from '@/components/terminal-pane/terminal-file-open-routing'

const harness = vi.hoisted(() => {
  const state: { value: Record<string, unknown> } = { value: {} }
  return {
    state,
    stat: vi.fn(async () => ({ isDirectory: false, size: 1, mtime: 0 })),
    rpc: vi.fn(async () => ({ isDirectory: false, size: 1, mtime: 0 })),
    open: vi.fn(() => null),
    reveal: vi.fn(),
    failure: vi.fn<(path: string, failure: FileOpenFailure) => void>(),
    pane: { startupCwd: '/home/u/proj/package', terminalHomePath: '/home/u' }
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => harness.state.value } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: harness.reveal,
  activateAndRevealWorktree: harness.reveal
}))
vi.mock('@/lib/file-link-open-failure-toast', () => ({
  showFileLinkOpenFailureToast: harness.failure
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: harness.rpc }))
vi.mock('@/components/terminal-pane/terminal-pane-wsl-distro', () => ({
  resolvePaneWslDistro: () => null
}))
vi.mock('@/lib/workspace-browser-route-eligibility', () => ({
  canOpenWorkspaceBrowserTabOnRuntime: () => false,
  canOpenWorkspaceBrowserTabOnSsh: () => false
}))
vi.mock('@/runtime/mounted-terminal-tab-registry', () => ({
  findRegisteredTerminalTab: () => ({
    tab: {
      getManager: () => ({ getNumericIdForLeaf: () => 1 }),
      getPtyIdForPane: () => 'pty-1',
      getLinkContextForPane: () => harness.pane
    }
  })
}))

const id = 'repo::/home/u/proj'
const path = '/home/u/proj'
function state(activeHost: string, proxied = false): Record<string, unknown> {
  return {
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: activeHost,
    settings: {},
    repos: [
      { id: 'repo', executionHostId: 'local' },
      { id: 'repo', executionHostId: 'ssh:box', connectionId: 'box' }
    ],
    worktreesByRepo: {
      repo: [
        { id, repoId: 'repo', path, hostId: 'local' },
        {
          id,
          repoId: 'repo',
          path,
          hostId: 'ssh:box',
          ...(proxied ? { runtimeOwnerEnvironmentId: 'hub' } : {})
        }
      ]
    },
    folderWorkspaces: [
      { id: 'folder', projectGroupId: 'g', folderPath: path, executionHostId: 'local' },
      {
        id: 'folder',
        projectGroupId: 'g',
        folderPath: path,
        executionHostId: 'ssh:box',
        connectionId: 'box'
      }
    ],
    projectGroups: [],
    openFiles: [],
    unifiedTabsByWorktree: {},
    openFileForLink: harness.open
  }
}
function source(executionHostId: 'local' | 'ssh:box', worktreeId = id) {
  return { executionHostId, worktreeId, tabId: 'tab', leafId: 'leaf', ptyId: 'pty-1' }
}
async function settle(): Promise<void> {
  // Drain the production stat/open chain without a wall-clock wait.
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
beforeEach(() => {
  vi.clearAllMocks()
  harness.stat.mockResolvedValue({ isDirectory: false, size: 1, mtime: 0 })
  harness.rpc.mockResolvedValue({ isDirectory: false, size: 1, mtime: 0 })
  harness.state.value = state('local')
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  vi.stubGlobal('window', { api: { fs: { stat: harness.stat } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('preview source through OSC file opening', () => {
  it.each([
    ['local', 'ssh:box', 'box'],
    ['ssh:box', 'local', undefined]
  ] as const)(
    'keeps source %s selection separate from card %s for git and folder twins',
    async (active, card, connectionId) => {
      for (const workspaceId of [id, 'folder:folder']) {
        harness.state.value = { ...state(active), activeWorktreeId: workspaceId }
        const context = previewTerminalLinkContext(source(card, workspaceId))
        handleOscLink('file:///home/u/proj/config.ts', { metaKey: true, ctrlKey: false }, context)
        await settle()
        expect(harness.stat).toHaveBeenLastCalledWith(
          expect.objectContaining({ filePath: `${path}/config.ts`, connectionId })
        )
        expect(harness.reveal).toHaveBeenLastCalledWith(
          workspaceId,
          expect.objectContaining({ executionHostId: card })
        )
        expect(harness.open).toHaveBeenLastCalledWith(
          expect.objectContaining({ filePath: `${path}/config.ts`, worktreeId: workspaceId }),
          expect.anything(),
          null,
          expect.any(Function)
        )
      }
    }
  )

  it('keeps a chosen file action bound to its source after active host selection changes', async () => {
    const request = vi.fn<(request: TerminalLinkActionRequest) => void>()
    const context = previewTerminalLinkContext(source('ssh:box'))
    const onInternalOpen = vi.fn()
    handleOscLink(
      'file:///home/u/proj/config.ts',
      {
        metaKey: false,
        ctrlKey: false,
        type: 'contextmenu',
        button: 2,
        preventDefault: vi.fn()
      },
      {
        ...context,
        onInternalOpen,
        linkActionContext: {
          paneId: 0,
          pointerGesture: { canRequestAction: () => false, dispose: vi.fn() },
          claimPtyMouse: () => true,
          request,
          focusTerminal: vi.fn(),
          sourceOwner: context.sourceOwner
        }
      }
    )
    expect(request).toHaveBeenCalledOnce()
    harness.state.value = state('local')
    request.mock.calls[0]?.[0].primary.run()
    await settle()
    expect(harness.stat).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'box' }))
    expect(onInternalOpen).toHaveBeenCalledOnce()
  })

  it('keeps the runtime transport and SSH place for a server-proxied source', async () => {
    harness.state.value = state('local', true)
    const context = previewTerminalLinkContext(source('ssh:box'))
    expect(context.fileContext).toMatchObject({
      target: { kind: 'environment', environmentId: 'hub' },
      connectionId: 'box',
      expectedExecutionHostId: 'ssh:box'
    })
    handleOscLink('file:///home/u/proj/config.ts', { metaKey: true, ctrlKey: false }, context)
    await settle()
    expect(harness.stat).not.toHaveBeenCalled()
    expect(harness.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'hub' },
      'files.stat',
      { worktree: `id:${id}`, relativePath: 'config.ts' },
      expect.anything()
    )
    expect(harness.reveal).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ executionHostId: 'ssh:box' })
    )
  })

  it.each(['src/main.ts:12', '~/note.ts'] as const)(
    'matches pane cwd/home resolution for %s',
    async (target) => {
      const context = previewTerminalLinkContext(source('ssh:box'))
      handleOscLink(target, { metaKey: true, ctrlKey: false }, context)
      await settle()
      const expected = target.startsWith('~') ? '/home/u/note.ts' : `${path}/package/src/main.ts`
      expect(harness.stat).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: expected, connectionId: 'box' })
      )
    }
  )

  it.each([
    ['ENOENT: missing', 'missing'],
    ['connection dropped', 'unverifiable']
  ] as const)('preserves existing file refusal feedback for %s', async (message, verdict) => {
    const error = new Error(message)
    harness.stat.mockRejectedValue(error)
    const context = previewTerminalLinkContext(source('ssh:box'))
    const onOpenFailure = vi.fn()
    openDetectedFilePath(`${path}/gone.ts`, null, null, { ...context, onOpenFailure })
    await settle()
    handleOscLink(`file://${path}/gone.ts`, { metaKey: true, ctrlKey: false }, context)
    await settle()
    expect(onOpenFailure).toHaveBeenCalledExactlyOnceWith({ verdict, error })
    expect(harness.failure).toHaveBeenCalledExactlyOnceWith(`${path}/gone.ts`, { verdict, error })
    expect(harness.open).not.toHaveBeenCalled()
    expect(harness.reveal).not.toHaveBeenCalled()
  })
})
