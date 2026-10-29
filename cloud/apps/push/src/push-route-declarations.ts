import nacl from 'tweetnacl'
import { pushRouteDeclarationContent, type PushRouteDeclaration } from '@orca-cloud/push-contract'
import type { PushDatabase } from './push-database.js'
import { pushDestination } from './push-occurrence-admission.js'

export async function declarePushRoutes(
  database: PushDatabase,
  value: PushRouteDeclaration,
  now: number
): Promise<boolean> {
  const content = pushRouteDeclarationContent(value)
  const publicKey = Buffer.from(value.routeKey, 'base64url')
  const signature = Buffer.from(value.signature, 'base64url')
  if (
    publicKey.toString('base64url') !== value.routeKey ||
    signature.toString('base64url') !== value.signature ||
    !nacl.sign.detached.verify(Buffer.from(content), signature, publicKey)
  )
    return false
  const destination = pushDestination(value)
  const hosts = JSON.stringify([...new Set(value.hosts)].sort())
  return database.transaction(async (tx) => {
    await tx.lockScope(`push-routes:${destination}`)
    const [device] = await tx.query(
      "SELECT registration_id FROM push_devices WHERE platform = ? AND token = ? AND COALESCE(apns_environment, '') = ? AND route_key = ? AND dead_at IS NULL LIMIT 1",
      [value.platform, value.token, value.apnsEnvironment ?? '', value.routeKey]
    )
    if (!device) return false
    const [previous] = await tx.query(
      'SELECT version, hosts_json FROM push_route_declarations WHERE destination = ? AND route_key = ?',
      [destination, value.routeKey]
    )
    if (previous && Number(previous.version) >= value.version)
      return Number(previous.version) === value.version && previous.hosts_json === hosts
    await tx.query(
      `INSERT INTO push_route_declarations(destination, route_key, version, hosts_json, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(destination, route_key) DO UPDATE SET version = excluded.version, hosts_json = excluded.hosts_json, updated_at = excluded.updated_at`,
      [destination, value.routeKey, value.version, hosts, now]
    )
    return true
  })
}
