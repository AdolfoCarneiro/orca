import { createHash } from 'node:crypto'
import type { PushNotification } from '@orca-cloud/push-contract'
import type { PushDatabase } from './push-database.js'
import type { PushDeviceRegistration } from './device-registry-store.js'
import type { QueuedPushDelivery } from './durable-push-store.js'

export type OccurrenceAdmission = 'admitted' | 'superseded' | 'deferred' | 'skipped'
export type OccurrenceAdmissionPort = {
  acquire(device: PushDeviceRegistration): Promise<OccurrenceAdmission>
  finalize(sent: boolean): Promise<void>
  renew(): Promise<void>
}

export function pushDestination(device: {
  platform: string
  token: string
  apnsEnvironment?: string
}): string {
  return createHash('sha256')
    .update(JSON.stringify([device.platform, device.apnsEnvironment ?? '', device.token]))
    .digest('hex')
}

function claimKey(identity: unknown[]): string {
  return `push-claim:${JSON.stringify(identity)}`
}

export function occurrenceAdmission(
  database: PushDatabase,
  queued: QueuedPushDelivery,
  now: () => number
): OccurrenceAdmissionPort {
  const { notification: n } = queued
  let identity: string[] | undefined
  return {
    async acquire(device) {
      if (!n.origin || !n.occurrence || !device.routeKey) return 'skipped'
      const candidate = [pushDestination(device), n.origin, n.occurrence]
      return database.transaction(async (tx) => {
        if (!(await tx.tryLockScope(claimKey(candidate)))) return 'deferred'
        const [declaration] = await tx.query(
          'SELECT hosts_json FROM push_route_declarations WHERE destination = ? AND route_key = ?',
          [candidate[0], device.routeKey]
        )
        if (
          !declaration ||
          !JSON.parse(String(declaration.hosts_json)).includes(queued.hostFingerprint)
        )
          return 'skipped'
        const [row] = await tx.query(
          'SELECT * FROM push_occurrence_claims WHERE destination = ? AND origin = ? AND occurrence = ?',
          candidate
        )
        if (row?.state === 'dismissed') return 'superseded'
        if (row?.winner_route_key === device.routeKey) {
          if (row.state === 'sent') return 'superseded'
          if (
            row.state === 'inflight' &&
            Number(row.lease_until) > now() &&
            row.batch_id !== queued.id
          )
            return 'deferred'
        }
        await tx.query(
          `INSERT INTO push_occurrence_claims(destination, origin, occurrence, state, batch_id, attempt, winner_host, winner_route_key, lease_until, created_at)
          VALUES (?, ?, ?, 'inflight', ?, ?, ?, ?, ?, ?) ON CONFLICT(destination, origin, occurrence) DO UPDATE SET state = excluded.state, batch_id = excluded.batch_id, attempt = excluded.attempt, winner_host = excluded.winner_host, winner_route_key = excluded.winner_route_key, lease_until = excluded.lease_until`,
          [
            ...candidate,
            queued.id,
            queued.lease,
            queued.hostFingerprint,
            device.routeKey,
            now() + 30_000,
            now()
          ]
        )
        identity = candidate
        return 'admitted'
      })
    },
    async finalize(sent) {
      const admittedIdentity = identity
      if (!admittedIdentity) return
      for (let attempt = 0; ; attempt++) {
        try {
          await database.transaction(async (tx) => {
            await tx.lockScope(claimKey(admittedIdentity))
            const fence = [...admittedIdentity, queued.id, queued.lease]
            await tx.query(
              sent
                ? "UPDATE push_occurrence_claims SET state = 'sent' WHERE destination = ? AND origin = ? AND occurrence = ? AND state = 'inflight' AND batch_id = ? AND attempt = ?"
                : "DELETE FROM push_occurrence_claims WHERE destination = ? AND origin = ? AND occurrence = ? AND state = 'inflight' AND batch_id = ? AND attempt = ?",
              fence
            )
          })
          return
        } catch (error) {
          if (attempt === 3) throw error
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
        }
      }
    },
    async renew() {
      const admittedIdentity = identity
      if (!admittedIdentity) return
      await database.transaction(async (tx) => {
        await tx.lockScope(claimKey(admittedIdentity))
        await tx.query(
          "UPDATE push_occurrence_claims SET lease_until = ? WHERE destination = ? AND origin = ? AND occurrence = ? AND state = 'inflight' AND batch_id = ? AND attempt = ?",
          [now() + 30_000, ...admittedIdentity, queued.id, queued.lease]
        )
      })
    }
  }
}

export async function fenceDismissedOccurrences(
  tx: PushDatabase,
  registrationId: string,
  notifications: PushNotification[],
  now: number
): Promise<void> {
  if (!notifications.some((notification) => notification.origin && notification.occurrence)) return
  const [device] = await tx.query(
    'SELECT platform, token, apns_environment FROM push_devices WHERE registration_id = ?',
    [registrationId]
  )
  if (!device) return
  const destination = pushDestination({
    platform: String(device.platform),
    token: String(device.token),
    ...(device.apns_environment ? { apnsEnvironment: String(device.apns_environment) } : {})
  })
  const identities = new Map(
    notifications
      .filter((n) => n.origin && n.occurrence)
      .map((n) => {
        const identity = [destination, n.origin!, n.occurrence!]
        return [claimKey(identity), identity]
      })
  )
  for (const [key, identity] of [...identities].sort(([a], [b]) => a.localeCompare(b))) {
    await tx.lockScope(key)
    await tx.query(
      `INSERT INTO push_occurrence_claims(destination, origin, occurrence, state, lease_until, created_at) VALUES (?, ?, ?, 'dismissed', 0, ?)
      ON CONFLICT(destination, origin, occurrence) DO UPDATE SET state = 'dismissed'`,
      [...identity, now]
    )
  }
}
