import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'expo-router'
import { loadHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'
import { useFocusedSettingsHostClients } from '../src/transport/settings-host-client-connections'
import VoiceSettingsScreen from '../src/settings/voice-settings-screen'
import { nativeVoiceSettingsOperations } from '../src/settings/native-voice-settings-operations'

export default function NativeVoiceSettingsRoute() {
  const router = useRouter()
  const [hosts, setHosts] = useState<HostProfile[]>([])
  useEffect(() => {
    void loadHosts().then(setHosts)
  }, [])
  const hostIds = useMemo(() => hosts.map((host) => host.id), [hosts])
  const { clients, focused } = useFocusedSettingsHostClients(hostIds)
  const connectedHost = clients.find((entry) => entry.state === 'connected')
  const client = connectedHost?.client ?? null
  // Keep the last host's key through reconnects so only a real host switch resets the screen.
  const [screenHostId, setScreenHostId] = useState<string | null>(null)
  if (connectedHost && connectedHost.hostId !== screenHostId) {
    setScreenHostId(connectedHost.hostId)
  }
  const operations = useMemo(
    () => (client ? nativeVoiceSettingsOperations(client) : null),
    [client]
  )
  return (
    <VoiceSettingsScreen
      key={screenHostId ?? 'disconnected'}
      operations={operations}
      focused={focused}
      onBack={() => router.back()}
    />
  )
}
