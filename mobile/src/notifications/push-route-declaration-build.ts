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

const KEY = 'orca.push-route-key'
const VERSION = 'orca:push-route-version'
let keyPromise: Promise<nacl.SignKeyPair | null> | null = null
function base64url(bytes: Uint8Array): string {
  return encodeBase64Bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function routeKeypair(
  create: boolean,
  isCurrent: () => boolean
): Promise<nacl.SignKeyPair | null> {
  keyPromise ??= (async () => {
    try {
      const stored = await readPairingKeychainItem(KEY)
      if (stored !== null) {
        const bytes = decodeBase64Bytes(stored)
        return bytes.length === 64 ? nacl.sign.keyPair.fromSecretKey(bytes) : null
      }
      if (!create || !isCurrent()) {
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
  return isCurrent() ? keypair : null
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
