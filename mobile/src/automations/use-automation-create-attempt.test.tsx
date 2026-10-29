// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAutomationCreateAttempt } from './use-automation-create-attempt'
import { automationClient, automationTargets, savedAutomation } from './automation-test-fixtures'
import { automationSetupKey } from './automation-target-inventory'
import { newAutomationDraft } from './automation-draft'
import { AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../src/shared/automation-runtime-capabilities'
import { automationListSchema, type MobileAutomationRow } from './automation-reply-schema'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

afterEach(cleanup)

const current = () => true
const draft = () => ({
  ...newAutomationDraft(savedAutomation()),
  setupId: automationSetupKey(automationTargets().setups[0]!),
  workspaceMode: 'existing' as const,
  workspaceId: 'workspace-1',
  extraAgentArgs: ''
})

describe('mobile automation create refusal recovery', () => {
  it.each([
    'invalid_argument',
    'automation_destination_invalid',
    'selector_not_found',
    'selector_ambiguous'
  ])(
    'sends corrected parameters after an initial %s with and without creation keys',
    async (code) => {
      for (const keyed of [false, true]) {
        const port = automationClient(() => ({ automation: savedAutomation() }))
        port.send.mockResolvedValueOnce({
          id: 'refused',
          ok: false,
          error: { code, message: 'Correct the target' }
        })
        const { result, unmount } = renderHook(() =>
          useAutomationCreateAttempt([], true, () => {}, current)
        )
        const capabilities = keyed ? [AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] : []
        await act(async () => {
          await expect(
            result.current.submit(port.client, draft(), automationTargets(), capabilities, current)
          ).rejects.toThrow(code)
        })
        const corrected = { ...draft(), workspaceId: 'corrected' }
        const targets = {
          ...automationTargets(),
          workspaces: [{ ...automationTargets().workspaces[0]!, worktreeId: 'corrected' }]
        }
        await act(async () => {
          await result.current.submit(port.client, corrected, targets, capabilities, current)
        })
        const initial = port.send.mock.calls[0]?.[1]
        const next = port.send.mock.calls[1]?.[1]
        expect(port.send).toHaveBeenCalledTimes(2)
        expect(initial).toMatchObject({ workspace: 'id:workspace-1' })
        expect(next).toMatchObject({ workspace: 'id:corrected' })
        if (keyed) {
          expect(initial).toHaveProperty('creationKey', expect.any(String))
          expect(next).toHaveProperty('creationKey', expect.any(String))
          expect(next).not.toMatchObject({
            creationKey:
              initial && typeof initial === 'object' && 'creationKey' in initial
                ? initial.creationKey
                : undefined
          })
        } else {
          expect(next).toHaveProperty('creationKey', undefined)
        }
        unmount()
      }
    }
  )

  it.each(['runtime_error', 'unknown-delivery'])(
    'retains %s attempts even when a later response is a prewrite refusal',
    async (failure) => {
      const port = automationClient(() => ({ automation: savedAutomation() }))
      if (failure === 'runtime_error') {
        port.send.mockResolvedValueOnce({
          id: 'uncertain',
          ok: false,
          error: { code: failure, message: 'Flush failed' }
        })
      } else {
        port.send.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('Reply lost')))
      }
      port.send.mockResolvedValueOnce({
        id: 'refused',
        ok: false,
        error: { code: 'selector_not_found', message: 'Gone' }
      })
      const { result } = renderHook(() => useAutomationCreateAttempt([], true, () => {}, current))
      const capabilities = [AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY]
      for (let index = 0; index < 2; index++) {
        await act(async () => {
          await expect(
            result.current.submit(
              port.client,
              { ...draft(), name: `revision${index}` },
              automationTargets(),
              capabilities,
              current
            )
          ).rejects.toThrow('may have applied')
        })
      }
      expect(port.send.mock.calls[1]?.[1]).toEqual(port.send.mock.calls[0]?.[1])
      expect(port.send.mock.calls[1]?.[1]).toMatchObject({ name: 'revision0' })
    }
  )

  it('keeps an unknown legacy attempt blocked instead of resubmitting changed input', async () => {
    const port = automationClient(() => ({ automation: savedAutomation() }))
    port.send.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('Reply lost')))
    const { result } = renderHook(() => useAutomationCreateAttempt([], true, () => {}, current))
    for (const name of ['original', 'corrected']) {
      await act(async () => {
        await expect(
          result.current.submit(port.client, { ...draft(), name }, automationTargets(), [], current)
        ).rejects.toThrow('may have applied')
      })
    }
    expect(port.send).toHaveBeenCalledOnce()
    expect(port.send.mock.calls[0]?.[1]).toMatchObject({ name: 'original' })
  })

  it('reconciles an uncertain keyed create while preserving edits made since submission', async () => {
    const port = automationClient(() => ({ automation: savedAutomation() }))
    port.send.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('Reply lost')))
    const reconcile = vi.fn()
    const { result, rerender } = renderHook(
      ({ rows }: { rows: MobileAutomationRow[] }) =>
        useAutomationCreateAttempt(rows, true, reconcile, current),
      { initialProps: { rows: [] } }
    )
    await act(async () => {
      await expect(
        result.current.submit(
          port.client,
          draft(),
          automationTargets(),
          [AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY],
          current
        )
      ).rejects.toThrow('may have applied')
    })
    const submitted = port.send.mock.calls[0]?.[1]
    if (
      !submitted ||
      typeof submitted !== 'object' ||
      !('creationKey' in submitted) ||
      typeof submitted.creationKey !== 'string'
    ) {
      throw new Error('Missing submitted key')
    }
    const saved = { ...savedAutomation(), creationKey: submitted.creationKey }
    const rows = automationListSchema.parse({
      automations: [saved],
      items: [{ automationId: saved.id, selector: { kind: 'self' } }]
    })
    act(() => result.current.observeDraft({ ...draft(), prompt: 'Revised after submit' }))
    rerender({ rows })
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(
      rows[0],
      expect.objectContaining({ prompt: 'Revised after submit' })
    )
    expect(port.send).toHaveBeenCalledOnce()
  })
})
