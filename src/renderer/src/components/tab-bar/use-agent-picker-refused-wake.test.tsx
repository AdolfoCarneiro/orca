// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const inventory: { state: 'pending' | 'successful' | 'failed' } = { state: 'failed' }
  const ensureDetectedAgentsForPicker = vi.fn(async () => [])
  const state = {
    readLocalAgentInventory: () => ({ ids: [], state: inventory.state }),
    ensureDetectedAgentsForPicker
  }
  return { inventory, ensureDetectedAgentsForPicker, state }
})
vi.mock('@/store', () => {
  const useAppStore = <T,>(selector: (state: typeof mocks.state) => T): T => selector(mocks.state)
  useAppStore.getState = () => mocks.state
  return { useAppStore }
})

import { useAgentPickerRefusedWake } from './use-agent-picker-refused-wake'

beforeEach(() => {
  mocks.inventory.state = 'failed'
  mocks.ensureDetectedAgentsForPicker.mockClear()
})

it('retries a refused local list as a wake when the user opens the picker (E9)', () => {
  renderHook(() => useAgentPickerRefusedWake(true, { kind: 'local', worktreeId: 'wt-1' }))
  expect(mocks.ensureDetectedAgentsForPicker).toHaveBeenCalledWith('wt-1')
})

it('wakes nothing while closed, for a known list, or for a remote host', () => {
  renderHook(() => useAgentPickerRefusedWake(false, { kind: 'local', worktreeId: 'wt-1' }))
  renderHook(() => useAgentPickerRefusedWake(true, { kind: 'ssh', connectionId: 'ssh-1' }))
  mocks.inventory.state = 'successful'
  renderHook(() => useAgentPickerRefusedWake(true, { kind: 'local', worktreeId: 'wt-1' }))
  expect(mocks.ensureDetectedAgentsForPicker).not.toHaveBeenCalled()
})
