import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NativeVoiceSettingsRoute from '../../app/voice-settings'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileSpeechSetup } from '../dictation/mobile-dictation-setup'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

const connections = vi.hoisted(
  (): {
    clients: { hostId: string; state: string; client: RpcClient }[]
  } => ({ clients: [] })
)
vi.mock('../transport/settings-host-client-connections', () => ({
  useFocusedSettingsHostClients: () => ({ clients: connections.clients, focused: true })
}))
vi.mock('../transport/host-store', () => ({ loadHosts: async () => [] }))
vi.mock('expo-router', () => ({ useRouter: () => ({ back() {} }) }))
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
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', ChevronRight: 'Icon' }))
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ visible }: { visible: boolean }) => (visible ? 'Model drawer open' : null)
}))
vi.mock('../components/VoiceModelList', () => ({ VoiceModelList: () => null }))

function pendingReply() {
  let resolve: (reply: RpcResponse) => void = () => {}
  const promise = new Promise<RpcResponse>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function setup(label: string, enabled: boolean): MobileSpeechSetup {
  return {
    enabled,
    dictationMode: 'toggle',
    selectedModelId: label,
    models: [{ id: label, label, provider: 'local', status: 'ready' }]
  }
}
function ok(result: MobileSpeechSetup): RpcResponse {
  return { id: 'voice', ok: true, result, _meta: { runtimeId: 'desktop' } }
}
function client(reply: ReturnType<typeof pendingReply>): RpcClient {
  return {
    sendRequest: vi.fn(() => reply.promise),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport() {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground() {},
    close() {}
  }
}

let renderer: ReactTestRenderer
afterEach(() => {
  act(() => renderer?.unmount())
  connections.clients = []
})

describe('voice settings host ownership', () => {
  it('releases the old host model controls while the replacement host loads', async () => {
    const firstRead = pendingReply()
    const secondRead = pendingReply()
    const first = client(firstRead)
    const second = client(secondRead)
    firstRead.resolve(ok(setup('Desktop A model', true)))
    connections.clients = [
      { hostId: 'a', state: 'connected', client: first },
      { hostId: 'b', state: 'connected', client: second }
    ]
    await act(async () => {
      renderer = create(createElement(NativeVoiceSettingsRoute))
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('Desktop A model')

    connections.clients = [
      { hostId: 'a', state: 'disconnected', client: first },
      { hostId: 'b', state: 'connected', client: second }
    ]
    await act(async () => {
      renderer.update(createElement(NativeVoiceSettingsRoute))
    })
    expect(second.sendRequest).toHaveBeenCalledWith('speech.models.list', null)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Desktop A model')
    expect(findAllByHostType(renderer.root, 'ActivityIndicator')).toHaveLength(1)
    expect(renderer.root.findAllByProps({ testID: 'voice-enabled' })).toHaveLength(0)
    await act(async () => {
      secondRead.resolve(ok(setup('Desktop B model', false)))
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('Desktop B model')
    expect(renderer.root.findByProps({ testID: 'voice-enabled' }).props.value).toBe(false)
  })

  it('starts the replacement read without waiting for a read owned by the departed host', async () => {
    const firstRead = pendingReply()
    const secondRead = pendingReply()
    const first = client(firstRead)
    const second = client(secondRead)
    connections.clients = [{ hostId: 'a', state: 'connected', client: first }]
    await act(async () => {
      renderer = create(createElement(NativeVoiceSettingsRoute))
    })
    connections.clients = [{ hostId: 'b', state: 'connected', client: second }]
    await act(async () => {
      renderer.update(createElement(NativeVoiceSettingsRoute))
    })
    expect(second.sendRequest).toHaveBeenCalledWith('speech.models.list', null)
    await act(async () => {
      secondRead.resolve(ok(setup('Desktop B model', false)))
    })
    await act(async () => {
      firstRead.resolve(ok(setup('Desktop A model', true)))
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('Desktop B model')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Desktop A model')
  })

  it('keeps setup and the open model drawer when the same host reconnects', async () => {
    const read = pendingReply()
    const host = client(read)
    read.resolve(ok(setup('Desktop A model', true)))
    connections.clients = [{ hostId: 'a', state: 'connected', client: host }]
    await act(async () => {
      renderer = create(createElement(NativeVoiceSettingsRoute))
    })
    await act(async () => {
      renderer.root.findByProps({ testID: 'voice-model-picker' }).props.onPress()
    })
    for (const state of ['reconnecting', 'connected']) {
      connections.clients = [{ hostId: 'a', state, client: host }]
      await act(async () => {
        renderer.update(createElement(NativeVoiceSettingsRoute))
      })
      expect(JSON.stringify(renderer.toJSON())).toContain('Model drawer open')
    }
    expect(findAllByHostType(renderer.root, 'ActivityIndicator')).toHaveLength(0)
    expect(renderer.root.findByProps({ testID: 'voice-enabled' }).props.value).toBe(true)
  })
})
