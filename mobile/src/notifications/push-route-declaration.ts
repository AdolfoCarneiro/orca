import AsyncStorage from '@react-native-async-storage/async-storage'
import * as ExpoCrypto from 'expo-crypto'
import nacl from 'tweetnacl'
import { pushRouteDeclarationContent } from '../../../cloud/packages/push-contract/src/route-declaration-content'
import { readPairingKeychainItem, writePairingKeychainItem } from '../transport/pairing-keychain'
import { decodeBase64Bytes, encodeBase64Bytes } from '../transport/base64-byte-codec'
import { readStoredHostProfilesForMutation } from '../transport/host-metadata-store'
import { hostListMutationsSettled } from '../transport/host-list-mutation-queue'
import { deriveHostFingerprint } from './push-host-fingerprint'
import type { MobilePushToken } from './push-token'

const GATEWAY_ORIGIN = process.env.EXPO_PUBLIC_PUSH_GATEWAY_ORIGIN ?? 'https://push.onorca.dev'
const KEY = 'orca.push-route-key'
const VERSION = 'orca:push-route-version'
let keyPromise: Promise<nacl.SignKeyPair | null> | null = null
let token: MobilePushToken | null = null
let enrolled = false
let generation = 0
let registrationWake = 0
let chain = Promise.resolve()
let retry: ReturnType<typeof setTimeout> | undefined
let publication:
  | { generation: number; body: string; acknowledged: boolean; sending: boolean }
  | undefined

function base64url(bytes: Uint8Array): string {
  return encodeBase64Bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function routeKeypair(create = false): Promise<nacl.SignKeyPair | null> {
  keyPromise ??= (async () => {
    try {
      const stored = await readPairingKeychainItem(KEY)
      if (stored !== null) {
        const bytes = decodeBase64Bytes(stored)
        return bytes.length === 64 ? nacl.sign.keyPair.fromSecretKey(bytes) : null
      }
      if (!create) {
        return null
      }
      const keypair = nacl.sign.keyPair.fromSeed(ExpoCrypto.getRandomBytes(32))
      await writePairingKeychainItem(KEY, encodeBase64Bytes(keypair.secretKey))
      return keypair
    } catch {
      return null
    }
  })()
  const keypair = await keyPromise
  if (!keypair) {
    keyPromise = null
  }
  return keypair
}

export async function mobilePushRouteKey(): Promise<string | undefined> {
  const keypair = await routeKeypair(true)
  return keypair ? base64url(keypair.publicKey) : undefined
}

function cancelRetry(): void {
  clearTimeout(retry)
  retry = undefined
}

async function send(current: NonNullable<typeof publication>, attempt = 0): Promise<void> {
  if (current.generation !== generation || current.acknowledged || current.sending) {
    return
  }
  cancelRetry()
  current.sending = true
  const wake = registrationWake
  let status: number | undefined
  try {
    const response = await fetch(`${GATEWAY_ORIGIN}/v1/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      body: current.body
    })
    status = response.status
    if (response.ok) {
      current.acknowledged = true
    }
  } catch {}
  current.sending = false
  if (current.generation !== generation || current.acknowledged) {
    return
  }
  // Registration drains asynchronously; one retry covers that race, then wait for an actual wake.
  const permanent = status !== undefined && status >= 400 && status < 500 && status !== 429
  if (permanent && (status !== 400 || attempt > 0) && wake === registrationWake) {
    return
  }
  retry = setTimeout(
    () => void send(current, attempt + 1),
    wake !== registrationWake ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6))
  )
}

export function publishPushRoutes(current: MobilePushToken, gatewayOrigin?: string): void {
  if (gatewayOrigin !== GATEWAY_ORIGIN) {
    return
  }
  enrolled = true
  registrationWake++
  if (JSON.stringify(token) !== JSON.stringify(current)) {
    refreshPushRoutes(current)
  } else if (publication) {
    if (!publication.acknowledged) {
      void send(publication)
    }
  } else {
    const candidate = generation
    void chain.then(() => {
      if (!publication && token && candidate === generation) {
        refreshPushRoutes(token)
      }
    })
  }
}

export function refreshPushRoutes(currentToken?: MobilePushToken): void {
  if (currentToken) {
    token = currentToken
  }
  if (!token) {
    return
  }
  const current = token
  const candidate = ++generation
  publication = undefined
  cancelRetry()
  chain = chain
    .catch(() => {})
    .then(async () => {
      const keypair = await routeKeypair()
      const rawVersion = await AsyncStorage.getItem(VERSION)
      if (!keypair || (rawVersion === null && !enrolled) || candidate !== generation) {
        return
      }
      await hostListMutationsSettled()
      const hosts = [
        ...new Set(
          (await readStoredHostProfilesForMutation()).flatMap((host) => {
            const fingerprint = deriveHostFingerprint(host.publicKeyB64)
            return fingerprint ? [fingerprint] : []
          })
        )
      ].sort()
      const saved = Number(rawVersion ?? 0)
      if (!Number.isSafeInteger(saved) || saved < 0 || saved === Number.MAX_SAFE_INTEGER) {
        return
      }
      const version = Math.max(Date.now(), saved + 1)
      const declaration = {
        v: 1 as const,
        ...current,
        routeKey: base64url(keypair.publicKey),
        version,
        hosts
      }
      const signedBody = () =>
        JSON.stringify({
          ...declaration,
          signature: base64url(
            nacl.sign.detached(
              new TextEncoder().encode(pushRouteDeclarationContent(declaration)),
              keypair.secretKey
            )
          )
        })
      // Withdraw stale participation while the complete catalog cannot fit the current protocol.
      if (hosts.length > 100) {
        declaration.hosts = []
      }
      let body = signedBody()
      if (new TextEncoder().encode(body).length > 16_384) {
        declaration.hosts = []
        body = signedBody()
      }
      if (candidate !== generation) {
        return
      }
      await AsyncStorage.setItem(VERSION, String(version))
      if (candidate !== generation) {
        return
      }
      publication = { generation: candidate, body, acknowledged: false, sending: false }
      await send(publication)
    })
    .catch(() => {
      if (candidate === generation) {
        retry = setTimeout(refreshPushRoutes, 5000)
      }
    })
}

export function stopPushRoutePublication(): void {
  generation++
  token = null
  enrolled = false
  publication = undefined
  cancelRetry()
}
