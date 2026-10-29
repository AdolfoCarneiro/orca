import AsyncStorage from '@react-native-async-storage/async-storage'
import * as ExpoCrypto from 'expo-crypto'
import nacl from 'tweetnacl'
import { pushRouteDeclarationContent } from '../../../cloud/packages/push-contract/src/route-declaration'
import { readPairingKeychainItem, writePairingKeychainItem } from '../transport/pairing-keychain'
import { decodeBase64Bytes, encodeBase64Bytes } from '../transport/base64-byte-codec'
import { loadHostCatalog } from '../transport/host-store'
import { deriveHostFingerprint } from './push-host-fingerprint'
import type { MobilePushToken } from './push-token'

const GATEWAY_ORIGIN = process.env.EXPO_PUBLIC_PUSH_GATEWAY_ORIGIN ?? 'https://push.onorca.dev'
const KEY = 'orca.push-route-key'
const VERSION = 'orca:push-route-version'
let keyPromise: Promise<nacl.SignKeyPair | null> | null = null
let token: MobilePushToken | null = null
let unsupported = false
let generation = 0
let chain = Promise.resolve()
let retry: ReturnType<typeof setTimeout> | undefined

function base64url(bytes: Uint8Array): string {
  return encodeBase64Bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function routeKeypair(): Promise<nacl.SignKeyPair | null> {
  keyPromise ??= (async () => {
    try {
      const stored = await readPairingKeychainItem(KEY)
      if (stored !== null) {
        const bytes = decodeBase64Bytes(stored)
        return bytes.length === 64 ? nacl.sign.keyPair.fromSecretKey(bytes) : null
      }
      const keypair = nacl.sign.keyPair.fromSeed(ExpoCrypto.getRandomBytes(32))
      await writePairingKeychainItem(KEY, encodeBase64Bytes(keypair.secretKey))
      return keypair
    } catch {
      keyPromise = null
      return null
    }
  })()
  return keyPromise
}

export async function mobilePushRouteKey(): Promise<string | undefined> {
  const keypair = await routeKeypair()
  return keypair ? base64url(keypair.publicKey) : undefined
}

export function publishPushRoutes(current: MobilePushToken, gatewayOrigin?: string): void {
  if (gatewayOrigin !== GATEWAY_ORIGIN) {
    return
  }
  token = current
  unsupported = false
  refreshPushRoutes()
}

export function refreshPushRoutes(currentToken?: MobilePushToken): void {
  if (token && currentToken) {
    token = currentToken
  }
  if (!token || unsupported) {
    return
  }
  const current = token
  const candidate = ++generation
  if (retry) {
    clearTimeout(retry)
  }
  chain = chain
    .catch(() => {})
    .then(async () => {
      const keypair = await routeKeypair()
      if (!keypair || candidate !== generation) {
        return
      }
      const hosts = (await loadHostCatalog()).flatMap((host) => {
        const fingerprint = deriveHostFingerprint(host.publicKeyB64)
        return fingerprint ? [fingerprint] : []
      })
      const saved = Number((await AsyncStorage.getItem(VERSION)) ?? 0)
      if (!Number.isSafeInteger(saved) || saved < 0) {
        return
      }
      const version = Math.max(Date.now(), saved + 1)
      await AsyncStorage.setItem(VERSION, String(version))
      const declaration = {
        v: 1 as const,
        ...current,
        routeKey: base64url(keypair.publicKey),
        version,
        hosts
      }
      const signature = base64url(
        nacl.sign.detached(
          new TextEncoder().encode(pushRouteDeclarationContent(declaration)),
          keypair.secretKey
        )
      )
      const body = JSON.stringify({ ...declaration, signature })
      const send = async (attempt: number): Promise<void> => {
        if (candidate !== generation || unsupported) {
          return
        }
        try {
          const response = await fetch(`${GATEWAY_ORIGIN}/v1/routes`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
            body
          })
          if (candidate !== generation) {
            return
          }
          if (response.status === 404) {
            unsupported = true
            return
          }
          if (response.ok) {
            return
          }
        } catch {}
        if (candidate === generation) {
          retry = setTimeout(
            () => {
              void send(attempt + 1)
            },
            Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6))
          )
        }
      }
      await send(0)
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
  if (retry) {
    clearTimeout(retry)
  }
}
