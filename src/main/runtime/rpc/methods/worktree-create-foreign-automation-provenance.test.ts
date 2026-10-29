import '../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

// Why: a desktop older than #34525 sends its own dispatch token, which this host cannot verify (#34433).
it('creates a plain workspace for a dispatch token from another automation owner', async () => {
  const createManagedWorktree = vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
  const fixture = {
    getRuntimeId: () => 'test-runtime',
    dedupeWorktreeCreate: <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
      run(),
    showRepo: vi.fn().mockResolvedValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 1,
      kind: 'git'
    }),
    showAutomation: () => {
      throw new Error('Automation not found')
    },
    listAutomationRuns: () => [],
    createManagedWorktree
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method worktree.create reaches, plus the id the dispatcher stamps on replies.
  const runtime = fixture as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

  const response = await dispatcher.dispatch({
    id: 'req-1',
    authToken: 'tok',
    method: 'worktree.create',
    params: {
      repo: 'repo-1',
      name: 'desktop-automation-workspace',
      automationProvenanceRequest: {
        automationId: 'desktop-automation',
        automationRunId: 'desktop-run',
        dispatchToken: 'desktop-token',
        createRequestId: 'create-request-desktop'
      }
    }
  })

  expect(response).toMatchObject({ ok: true })
  expect(createManagedWorktree).toHaveBeenCalledWith(
    expect.not.objectContaining({ automationProvenance: expect.anything() })
  )
})
