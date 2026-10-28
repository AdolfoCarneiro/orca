import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VoiceSettingsScreen from './voice-settings-screen'
import { nativeVoiceSettingsOperations } from './native-voice-settings-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileSpeechSetup } from '../dictation/mobile-dictation-setup'
import { BottomDrawer } from '../components/BottomDrawer'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Switch: 'Switch',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  ChevronRight: 'Icon',
  Check: 'Icon',
  Download: 'Icon',
  Trash2: 'Icon'
}))
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? children : null
}))

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const initial: MobileSpeechSetup = {
  enabled: true,
  dictationMode: 'toggle',
  selectedModelId: '',
  models: []
}

function ok(setup: MobileSpeechSetup): RpcResponse {
  return { id: 'voice', ok: true, result: setup, _meta: { runtimeId: 'desktop' } }
}

function desktop(loaded: MobileSpeechSetup = initial) {
  const changes: ReturnType<typeof deferred<RpcResponse>>[] = []
  const polls: ReturnType<typeof deferred<RpcResponse>>[] = []
  let loadCount = 0
  const sendRequest = vi.fn(async (method: string): Promise<RpcResponse> => {
    if (method === 'speech.models.list' && loadCount++ === 0) {
      return ok(loaded)
    }
    const request = deferred<RpcResponse>()
    if (method === 'speech.models.list') {
      polls.push(request)
    } else {
      changes.push(request)
    }
    return request.promise
  })
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport() {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground() {},
    close() {}
  }
  return { operations: nativeVoiceSettingsOperations(client), sendRequest, changes, polls }
}

let renderer: ReactTestRenderer
afterEach(() => {
  act(() => renderer?.unmount())
  vi.useRealTimers()
})

async function mount(operations: ReturnType<typeof nativeVoiceSettingsOperations>) {
  await act(async () => {
    renderer = create(
      createElement(VoiceSettingsScreen, { operations, focused: true, onBack() {} })
    )
  })
}

function toggle(enabled: boolean) {
  return act(async () => {
    const control = renderer.root.findByProps({ testID: 'voice-enabled' })
    expect(control.props.disabled).toBeUndefined()
    control.props.onValueChange(enabled)
  })
}

describe('voice settings response ownership', () => {
  it('keeps the last switch choice when earlier RPC snapshots arrive last', async () => {
    const host = desktop()
    await mount(host.operations)
    await toggle(false)
    await toggle(true)
    expect(host.sendRequest).toHaveBeenNthCalledWith(2, 'speech.dictation.setup', {
      enabled: false
    })
    expect(host.sendRequest).toHaveBeenNthCalledWith(3, 'speech.dictation.setup', { enabled: true })
    await act(async () => {
      host.changes[1]!.resolve(ok(initial))
    })
    await act(async () => {
      host.changes[0]!.resolve(ok({ ...initial, enabled: false }))
    })
    expect(renderer.root.findByProps({ testID: 'voice-enabled' }).props.value).toBe(true)
  })

  it('keeps a newer optimistic choice while its save is still pending', async () => {
    const host = desktop()
    await mount(host.operations)
    await act(async () => {
      renderer.root.findByProps({ testID: 'voice-mode-hold' }).props.onPress()
    })
    await toggle(false)
    await act(async () => {
      host.changes[0]!.resolve(ok({ ...initial, dictationMode: 'hold' }))
    })
    expect(renderer.root.findByProps({ testID: 'voice-enabled' }).props.value).toBe(false)
    await act(async () => {
      host.changes[1]!.resolve(ok({ ...initial, enabled: false, dictationMode: 'hold' }))
    })
  })

  it('does not show an old save failure after a newer save succeeds', async () => {
    const host = desktop()
    await mount(host.operations)
    await toggle(false)
    await toggle(true)
    await act(async () => {
      host.changes[1]!.resolve(ok(initial))
    })
    await act(async () => {
      host.changes[0]!.reject(new Error('Older request disconnected'))
    })
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Older request disconnected')
    expect(renderer.root.findByProps({ testID: 'voice-enabled' }).props.value).toBe(true)
  })

  it('drops a superseded progress-poll failure after a successful user edit', async () => {
    vi.useFakeTimers()
    const host = desktop({
      ...initial,
      models: [
        {
          id: 'small',
          label: 'Small',
          provider: 'local',
          sizeBytes: 100,
          recommended: true,
          status: 'downloading',
          progress: 0.1
        }
      ]
    })
    await mount(host.operations)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(host.polls).toHaveLength(1)
    await toggle(false)
    await act(async () => {
      host.changes[0]!.resolve(ok({ ...initial, enabled: false }))
    })
    await act(async () => {
      host.polls[0]!.reject(new Error('Old progress read failed'))
    })
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Old progress read failed')
    expect(renderer.root.findByProps({ testID: 'voice-enabled' }).props.value).toBe(false)
  })

  it.each([
    ['resolves', undefined],
    ['rejects', 'Model is in use']
  ])('reconciles when a pending delete %s after a switch edit', async (_outcome, failure) => {
    const model = { id: 'small', label: 'Small', provider: 'local', status: 'ready' } as const
    const deleted = { ...model, status: 'not-downloaded' } as const
    const host = desktop({ ...initial, selectedModelId: 'small', models: [model] })
    await mount(host.operations)
    await act(async () => {
      renderer.root.findByProps({ testID: 'voice-model-picker' }).props.onPress()
    })
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Delete Small' }).props.onPress()
    })
    await toggle(false)
    await act(async () => {
      host.changes[1]!.resolve(
        ok({ ...initial, enabled: false, selectedModelId: 'small', models: [model] })
      )
    })
    await act(async () => {
      if (failure) {
        host.changes[0]!.reject(new Error(failure))
      } else {
        host.changes[0]!.resolve(ok({ ...initial, enabled: false, models: [deleted] }))
      }
    })
    if (failure) {
      expect(JSON.stringify(renderer.toJSON())).toContain(failure)
    }
    expect(host.polls).toHaveLength(1)
    await act(async () => {
      host.polls[0]!.resolve(ok({ ...initial, enabled: false, models: [deleted] }))
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('None selected')
  })

  it('does not let a model-selection snapshot re-enable voice after a later switch edit', async () => {
    const model = { id: 'small', label: 'Small', provider: 'local', status: 'ready' } as const
    const host = desktop({ ...initial, models: [model] })
    await mount(host.operations)
    await act(async () => {
      renderer.root.findByProps({ testID: 'voice-model-picker' }).props.onPress()
    })
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Use Small' }).props.onPress()
    })
    await act(async () => {
      renderer.root.findByType(BottomDrawer).props.onClose()
    })
    await toggle(false)
    await act(async () => {
      host.changes[1]!.resolve(
        ok({ ...initial, enabled: false, selectedModelId: 'small', models: [model] })
      )
    })
    await act(async () => {
      host.changes[0]!.resolve(ok({ ...initial, selectedModelId: 'small', models: [model] }))
    })
    expect(renderer.root.findByProps({ testID: 'voice-enabled' }).props.value).toBe(false)
  })
})
