// @vitest-environment happy-dom
import {
  mocks,
  detailTransport,
  actualSearch,
  pickerStore,
  LinearPicker,
  prepareDefaultPicker
} from './smart-workspace-linear-read-test-fixtures'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { credentialDecryptionMessage } from '../../../../shared/integration-credential-errors'
import { searchIssues } from '../../../../main/linear/linear-issue-lookups'
import { LINEAR_METHODS } from '../../../../main/runtime/rpc/methods/linear'
import { mapDispatcherError } from '../../../../main/runtime/rpc/dispatcher-error-response'
import { successResponse } from '../../../../main/runtime/rpc/errors'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'
import type { RpcContext } from '../../../../main/runtime/rpc/core'

it.each(['sdk-auth', 'credential'] as const)(
  'real main/RPC/renderer classifies %s safely and refreshes concrete default status',
  async (kind) => {
    prepareDefaultPicker({ connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' })
    detailTransport.clear.mockReset()
    const raw =
      kind === 'sdk-auth'
        ? '401 private authentication diagnostic'
        : credentialDecryptionMessage('Linear')
    detailTransport.search.mockRejectedValue(new Error(raw))
    detailTransport.clear.mockImplementation(() => {
      mocks.state.linearStatus = { connected: false, viewer: null }
    })
    const method = LINEAR_METHODS.find((item) => item.name === 'linear.searchIssues')!
    // SAFETY: this production RPC method calls only linearSearchIssues on the supplied runtime.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    const context = { runtime: { linearSearchIssues: searchIssues } } as unknown as RpcContext
    detailTransport.rpc.mockImplementation(async (_target, name, params) => {
      expect(name).toBe(method.name)
      const request = { id: 'safe-search', authToken: '', method: name, params },
        meta = { runtimeId: 'test' }
      try {
        return unwrapRuntimeRpcResult(
          successResponse(
            request.id,
            meta,
            await method.handler(method.params.parse(params), context)
          )
        )
      } catch (error) {
        return unwrapRuntimeRpcResult(mapDispatcherError(request, meta, error))
      }
    })
    mocks.state.searchLinearIssues.mockImplementation((query, source, limit, workspaceId) =>
      actualSearch.linearSearchIssues(source, query, limit, workspaceId)
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = mocks.statusReads.mock.calls.length
    const mounted = render(<LinearPicker value="auth-boundary" defaultSource />)
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
    if (kind === 'credential') {
      await waitFor(() => expect(screen.getByText('Reconnect Linear')).toBeTruthy())
      expect(
        screen.getAllByText('Unable to read saved Linear login. Reconnect it in Settings.')
      ).toHaveLength(1)
      expect(detailTransport.clear).not.toHaveBeenCalled()
    } else {
      await waitFor(() => expect(pickerStore.getState().linearStatus.connected).toBe(false))
      await waitFor(() =>
        expect(screen.getByText('Start typing to create a name or find a source.')).toBeTruthy()
      )
      expect(screen.queryByText('Reconnect Linear')).toBeNull()
      expect(screen.queryByText(raw)).toBeNull()
      expect(detailTransport.clear).toHaveBeenCalledWith('workspace-1')
    }
    expect(mocks.statusReads.mock.calls.length).toBeGreaterThan(before)
    expect(warn).toHaveBeenCalledWith(
      kind === 'credential' ? '[linear] searchIssues failed:' : '[linear] issue read failed:',
      expect.objectContaining({
        message: kind === 'credential' ? raw : 'Unable to load Linear issues. Try again.'
      })
    )
    mounted.unmount()
    warn.mockRestore()
    detailTransport.clear.mockReset()
  }
)
