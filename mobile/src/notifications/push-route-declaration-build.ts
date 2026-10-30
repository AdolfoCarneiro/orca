import AsyncStorage from '@react-native-async-storage/async-storage'
import nacl from 'tweetnacl'
import { pushRouteDeclarationContent } from '../../../cloud/packages/push-contract/src/route-declaration-content'
import { encodeBase64Bytes } from '../transport/base64-byte-codec'
import { readStoredHostProfilesForMutation } from '../transport/host-metadata-store'
import { hostListMutationsSettled } from '../transport/host-list-mutation-queue'
import { deriveHostFingerprint } from './push-host-fingerprint'
import type { MobilePushToken } from './push-token'

import { prepareKey, routeKeyPreparationSnapshotForTests } from './push-route-key-preparation'
export { mobilePushRouteKey, type RouteKeyPreparation } from './push-route-key-preparation'

const VERSION = 'orca:push-route-version'
export type RouteDeclarationPreparation = {
  readonly result: Promise<
    { status: 'ready'; body: string } | { status: 'unavailable' | 'retired' }
  >
  release(): void
}
function base64url(bytes: Uint8Array): string {
  return encodeBase64Bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
type DeclarationCell = {
  current?: () => boolean
  token?: MobilePushToken
  enrolled?: boolean
  resolve?: (value: Awaited<RouteDeclarationPreparation['result']>) => void
  reject?: (error: unknown) => void
  key?: ReturnType<typeof prepareKey>
  keypair?: nacl.SignKeyPair
  body?: string
  version?: number
}
let builder: DeclarationCell | undefined
let latestBuild: DeclarationCell | undefined
function finishBuild(
  cell: DeclarationCell,
  result: Awaited<RouteDeclarationPreparation['result']>,
  failure?: { error: unknown }
): void {
  const resolve = cell.resolve
  const reject = cell.reject
  cell.current = undefined
  cell.token = undefined
  cell.enrolled = undefined
  cell.resolve = undefined
  cell.reject = undefined
  cell.key?.release()
  cell.key = undefined
  cell.keypair = undefined
  cell.body = undefined
  cell.version = undefined
  if (latestBuild === cell) {
    latestBuild = undefined
  }
  if (failure) {
    reject?.(failure.error)
  } else {
    resolve?.(result)
  }
}
function currentBuild(cell: DeclarationCell): boolean {
  if (cell.current?.()) {
    return true
  }
  finishBuild(cell, { status: 'retired' })
  return false
}
function signBody(
  cell: DeclarationCell,
  rawVersion: string | null,
  profiles: Awaited<ReturnType<typeof readStoredHostProfilesForMutation>>
): void {
  if (!cell.token || !cell.keypair) {
    return
  }
  const saved = Number(rawVersion ?? 0)
  if (!Number.isSafeInteger(saved) || saved < 0 || saved === Number.MAX_SAFE_INTEGER) {
    return
  }
  const declaration = {
    v: 1 as const,
    ...cell.token,
    routeKey: base64url(cell.keypair.publicKey),
    version: Math.max(Date.now(), saved + 1),
    hosts: [
      ...new Set(
        profiles.flatMap((host) => {
          const fingerprint = deriveHostFingerprint(host.publicKeyB64)
          return fingerprint ? [fingerprint] : []
        })
      )
    ].sort()
  }
  const keypair = cell.keypair
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
  if (declaration.hosts.length > 100) {
    declaration.hosts = []
  }
  cell.body = signedBody()
  if (new TextEncoder().encode(cell.body).length > 16_384) {
    declaration.hosts = []
    cell.body = signedBody()
  }
  cell.version = declaration.version
}
async function runBuilder(cell: DeclarationCell): Promise<void> {
  try {
    cell.key = prepareKey(false, () => cell.current?.() === true)
    const key = await cell.key.result
    if (!currentBuild(cell)) {
      return
    }
    if (key.status !== 'ready') {
      finishBuild(cell, { status: 'unavailable' })
      return
    }
    cell.keypair = key.keypair
    const version = await AsyncStorage.getItem(VERSION)
    if (!currentBuild(cell)) {
      return
    }
    if (version === null && !cell.enrolled) {
      finishBuild(cell, { status: 'unavailable' })
      return
    }
    await hostListMutationsSettled()
    if (!currentBuild(cell)) {
      return
    }
    const profiles = await readStoredHostProfilesForMutation()
    if (!currentBuild(cell)) {
      return
    }
    signBody(cell, version, profiles)
    if (!currentBuild(cell)) {
      return
    }
    if (cell.body === undefined || cell.version === undefined) {
      finishBuild(cell, { status: 'unavailable' })
      return
    }
    await AsyncStorage.setItem(VERSION, String(cell.version))
    if (currentBuild(cell) && cell.body !== undefined) {
      finishBuild(cell, { status: 'ready', body: cell.body })
    }
  } catch (error) {
    if (currentBuild(cell)) {
      finishBuild(cell, { status: 'unavailable' }, { error })
    }
  } finally {
    if (builder === cell) {
      builder = undefined
    }
    startLatestBuild()
  }
}
function startLatestBuild(): void {
  if (builder || !latestBuild) {
    return
  }
  builder = latestBuild
  latestBuild = undefined
  if (currentBuild(builder)) {
    void runBuilder(builder)
  } else {
    builder = undefined
  }
}
export function buildPushRouteDeclaration(
  token: MobilePushToken,
  enrolled: boolean,
  isCurrent: () => boolean
): RouteDeclarationPreparation {
  if (builder) {
    finishBuild(builder, { status: 'retired' })
  }
  if (latestBuild) {
    finishBuild(latestBuild, { status: 'retired' })
  }
  const deferred = Promise.withResolvers<Awaited<RouteDeclarationPreparation['result']>>()
  const cell: DeclarationCell = {
    token,
    enrolled,
    current: isCurrent,
    resolve: deferred.resolve,
    reject: deferred.reject
  }
  latestBuild = cell
  startLatestBuild()
  return {
    result: deferred.promise,
    release() {
      finishBuild(cell, { status: 'retired' })
    }
  }
}
export function pushRoutePreparationSnapshotForTests() {
  return {
    ...routeKeyPreparationSnapshotForTests(),
    builder: Number(builder !== undefined),
    latest: Number(latestBuild !== undefined),
    builderCallables:
      Number(builder?.current !== undefined) + Number(latestBuild?.current !== undefined),
    builderPayloads:
      Number(builder?.token !== undefined) + Number(latestBuild?.token !== undefined),
    builderBodies: Number(builder?.body !== undefined) + Number(latestBuild?.body !== undefined)
  }
}
