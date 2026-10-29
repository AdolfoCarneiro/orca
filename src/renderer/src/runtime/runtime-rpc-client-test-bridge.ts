import { beforeEach, vi } from 'vitest'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

export const runtimeCall = vi.fn()
export const runtimeEnvironmentCall = vi.fn()
export const runtimeEnvironmentSubscribe = vi.fn()

export function installRuntimeRpcClientTestBridge(): void {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    runtimeCall.mockReset()
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentSubscribe.mockReset()
    vi.stubGlobal('window', {
      api: {
        runtime: { call: runtimeCall },
        runtimeEnvironments: {
          call: runtimeEnvironmentCall,
          cancelSubscription: vi.fn().mockResolvedValue(undefined),
          subscribe: runtimeEnvironmentSubscribe
        }
      }
    })
  })
}
