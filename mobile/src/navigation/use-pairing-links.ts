import { useEffect } from 'react'
import { useRouter } from 'expo-router'
import * as Linking from 'expo-linking'
import { extractPairingCodeFromUrl } from '../transport/pairing'

let initialUrlRequested = false

export function usePairingLinks(): void {
  const router = useRouter()
  useEffect(() => {
    let disposed = false
    function handleUrl(url: string) {
      if (disposed) {
        return
      }
      const code = extractPairingCodeFromUrl(url)
      if (code) {
        // Replace the camera's unmatched pair route so Back cannot reveal the router error.
        router.replace({ pathname: '/pair-confirm', params: { code } })
      }
    }

    // A recovery remount must not replay the link that launched this process.
    if (!initialUrlRequested) {
      initialUrlRequested = true
      void Linking.getInitialURL()
        .then((url) => {
          if (url) {
            handleUrl(url)
          }
        })
        .catch(() => {})
    }
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url))
    return () => {
      disposed = true
      sub.remove()
    }
  }, [router])
}
