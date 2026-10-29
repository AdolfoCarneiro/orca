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
type KeyResult =
  | { status: 'ready'; keypair: nacl.SignKeyPair }
  | { status: 'unavailable' | 'retired' }
export type RouteKeyPreparation = {
  readonly result: Promise<
    { status: 'ready'; routeKey: string } | { status: 'unavailable' | 'retired' }
  >
  release(): void
}
export type RouteDeclarationPreparation = {
  readonly result: Promise<
    { status: 'ready'; body: string } | { status: 'unavailable' | 'retired' }
  >
  release(): void
}
type Authority = { current?: () => boolean }
type KeyEntry = {
  ensure: boolean
  current?: () => boolean
  resolve?: (result: KeyResult) => void
  authority?: Authority
}
type KeyTask = { authority?: Authority }
let committedKey: nacl.SignKeyPair | undefined
const keyEntries = new Set<KeyEntry>()
let keyTask: KeyTask | undefined
function base64url(bytes: Uint8Array): string {
  return encodeBase64Bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function observeRouteKey(): Promise<KeyObservation> {
  if (committedKey) {
    return { status: 'present', keypair: committedKey }
  }
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
}
function finishKey(entry: KeyEntry, result: KeyResult): void {
  keyEntries.delete(entry)
  if (entry.authority) {
    entry.authority.current = undefined
  }
  const resolve = entry.resolve
  entry.current = undefined
  entry.resolve = undefined
  entry.authority = undefined
  resolve?.(result)
}
function completeKeyCohort(observed: KeyObservation): void {
  for (const entry of keyEntries) {
    if (!entry.current?.()) {
      finishKey(entry, { status: 'retired' })
    } else if (observed.status === 'present') {
      finishKey(entry, { status: 'ready', keypair: observed.keypair })
    } else if (observed.status === 'unavailable' || !entry.ensure) {
      finishKey(entry, { status: 'unavailable' })
    }
  }
}
function selectCreator(task: KeyTask): boolean {
  for (const entry of keyEntries) {
    if (!entry.current?.()) {
      finishKey(entry, { status: 'retired' })
    } else if (entry.ensure) {
      task.authority = entry.authority = { current: entry.current }
      return true
    }
  }
  return false
}
async function createRouteKey(
  authority: Authority
): Promise<KeyObservation | { status: 'retired' }> {
  const fresh = await observeRouteKey()
  if (fresh.status !== 'missing') {
    return fresh
  }
  if (!authority.current?.()) {
    return { status: 'retired' }
  }
  try {
    const candidate = nacl.sign.keyPair.fromSeed(ExpoCrypto.getRandomBytes(32))
    const written = await writePairingKeychainItemIfCurrent(
      KEY,
      encodeBase64Bytes(candidate.secretKey),
      () => authority.current?.() === true
    )
    if (written === 'retired') {
      return { status: 'retired' }
    }
    committedKey = candidate
    return { status: 'present', keypair: candidate }
  } catch {
    return { status: 'unavailable' }
  }
}
async function runKeyTask(task: KeyTask): Promise<void> {
  completeKeyCohort(await observeRouteKey())
  while (selectCreator(task) && task.authority) {
    // The writer receives this exact permanently retireable cell, never a successor's slot.
    const fresh = await createRouteKey(task.authority)
    if (fresh.status !== 'retired') {
      completeKeyCohort(fresh)
      break
    }
    task.authority.current = undefined
    task.authority = undefined
  }
  if (task.authority) {
    task.authority.current = undefined
  }
  if (keyTask === task) {
    keyTask = undefined
  }
}
function prepareKey(ensure: boolean, current: () => boolean) {
  if (committedKey) {
    const result: KeyResult = current()
      ? { status: 'ready', keypair: committedKey }
      : { status: 'retired' }
    return { result: Promise.resolve(result), release() {} }
  }
  const deferred = Promise.withResolvers<KeyResult>()
  const entry: KeyEntry = { ensure, current, resolve: deferred.resolve }
  keyEntries.add(entry)
  if (!current()) {
    finishKey(entry, { status: 'retired' })
  } else if (!keyTask) {
    keyTask = {}
    void runKeyTask(keyTask)
  }
  return {
    result: deferred.promise,
    release() {
      finishKey(entry, { status: 'retired' })
    }
  }
}
export function mobilePushRouteKey(isCurrent: () => boolean): RouteKeyPreparation {
  const interest = prepareKey(true, isCurrent)
  return {
    result: interest.result.then<Awaited<RouteKeyPreparation['result']>>((result) =>
      result.status === 'ready'
        ? { status: 'ready', routeKey: base64url(result.keypair.publicKey) }
        : result
    ),
    release: interest.release
  }
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
    keyEntries: keyEntries.size,
    keyCallables: [...keyEntries].filter((entry) => entry.current !== undefined).length,
    keyTask: Number(keyTask !== undefined),
    creatorCells: Number(keyTask?.authority !== undefined),
    creator: Number(keyTask?.authority?.current !== undefined),
    builder: Number(builder !== undefined),
    latest: Number(latestBuild !== undefined),
    builderCallables:
      Number(builder?.current !== undefined) + Number(latestBuild?.current !== undefined),
    builderPayloads:
      Number(builder?.token !== undefined) + Number(latestBuild?.token !== undefined),
    builderBodies: Number(builder?.body !== undefined) + Number(latestBuild?.body !== undefined)
  }
}
