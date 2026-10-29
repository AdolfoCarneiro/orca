import AsyncStorage from '@react-native-async-storage/async-storage'
import * as ExpoCrypto from 'expo-crypto'
import nacl from 'tweetnacl'
import { pushRouteDeclarationContent } from '../../../cloud/packages/push-contract/src/route-declaration-content'
import {
  readPairingKeychainItem,
  writePairingKeychainItemIfCurrent
} from '../transport/pairing-keychain'
import { decodeBase64Bytes, encodeBase64Bytes } from '../transport/base64-byte-codec'
import { readStoredHostProfilesForMutation } from '../transport/host-metadata-store'
import { hostListMutationsSettled } from '../transport/host-list-mutation-queue'
import { deriveHostFingerprint } from './push-host-fingerprint'
import type { MobilePushToken } from './push-token'

const KEY = 'orca.push-route-key'
const VERSION = 'orca:push-route-version'
type KeyObservation =
  | { status: 'present'; keypair: nacl.SignKeyPair }
  | { status: 'missing' | 'unavailable' }
let committedKey: nacl.SignKeyPair | undefined
let observation: Promise<KeyObservation> | undefined
let creation: Promise<KeyObservation | { status: 'retired' }> | undefined
function base64url(bytes: Uint8Array): string {
  return encodeBase64Bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function observeRouteKey(): Promise<KeyObservation> {
  if (committedKey) {
    return { status: 'present', keypair: committedKey }
  }
  if (!observation) {
    const pending = (async (): Promise<KeyObservation> => {
      try {
        const stored = await readPairingKeychainItem(KEY)
        if (stored === null) {
          return { status: 'missing' }
        }
        const bytes = decodeBase64Bytes(stored)
        if (bytes.length !== 64) {
          return { status: 'unavailable' }
        }
        committedKey = nacl.sign.keyPair.fromSecretKey(bytes)
        return { status: 'present', keypair: committedKey }
      } catch {
        return { status: 'unavailable' }
      }
    })()
    observation = pending
    void pending.finally(() => {
      if (observation === pending) {
        observation = undefined
      }
    })
  }
  return observation
}

async function routeKeypair(
  create: boolean,
  isCurrent: () => boolean
): Promise<nacl.SignKeyPair | null> {
  let result = await observeRouteKey()
  if (create && result.status === 'missing') {
    while (isCurrent()) {
      if (!creation) {
        const pending = (async (): Promise<KeyObservation | { status: 'retired' }> => {
          try {
            if (committedKey) {
              return { status: 'present', keypair: committedKey }
            }
            const fresh = await observeRouteKey()
            if (fresh.status !== 'missing') {
              return fresh
            }
            if (!isCurrent()) {
              return { status: 'retired' }
            }
            const keypair = nacl.sign.keyPair.fromSeed(ExpoCrypto.getRandomBytes(32))
            const written = await writePairingKeychainItemIfCurrent(
              KEY,
              encodeBase64Bytes(keypair.secretKey),
              isCurrent
            )
            if (written === 'retired') {
              return { status: 'retired' }
            }
            committedKey = keypair
            return { status: 'present', keypair }
          } catch {
            return { status: 'unavailable' }
          }
        })()
        creation = pending
        void pending.finally(() => {
          if (creation === pending) {
            creation = undefined
          }
        })
      }
      const ensured = await creation
      if (ensured.status === 'retired') {
        continue
      }
      result = ensured
      break
    }
  }
  return isCurrent() && result.status === 'present' ? result.keypair : null
}

export async function mobilePushRouteKey(isCurrent: () => boolean): Promise<string | undefined> {
  const keypair = await routeKeypair(true, isCurrent)
  return keypair ? base64url(keypair.publicKey) : undefined
}

export async function buildPushRouteDeclaration(
  token: MobilePushToken,
  enrolled: boolean,
  isCurrent: () => boolean
): Promise<string | undefined> {
  const keypair = await routeKeypair(false, isCurrent)
  if (!isCurrent()) {
    return
  }
  const rawVersion = await AsyncStorage.getItem(VERSION)
  if (!keypair || (rawVersion === null && !enrolled) || !isCurrent()) {
    return
  }
  await hostListMutationsSettled()
  if (!isCurrent()) {
    return
  }
  const hosts = [
    ...new Set(
      (await readStoredHostProfilesForMutation()).flatMap((host) => {
        const fingerprint = deriveHostFingerprint(host.publicKeyB64)
        return fingerprint ? [fingerprint] : []
      })
    )
  ].sort()
  if (!isCurrent()) {
    return
  }
  const saved = Number(rawVersion ?? 0)
  if (!Number.isSafeInteger(saved) || saved < 0 || saved === Number.MAX_SAFE_INTEGER) {
    return
  }
  const version = Math.max(Date.now(), saved + 1)
  const declaration = {
    v: 1 as const,
    ...token,
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
  if (!isCurrent()) {
    return
  }
  await AsyncStorage.setItem(VERSION, String(version))
  if (!isCurrent()) {
    return
  }
  return body
}
