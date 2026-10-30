import { catalogObjectPresence, type SchemaCatalogQuery } from './catalog-object-precheck.js'
import type { SchemaLockTarget } from './schema-lock-target.js'

const CREATE_INDEX_CONCURRENTLY = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i

export function buildsIndexConcurrently(sql: string): boolean {
  return CREATE_INDEX_CONCURRENTLY.test(sql)
}

// One key for every build: two partial-index builds wait on each other's snapshots and deadlock.
const BUILDER_LOCK_KEY = 'orca_postgres_schema_concurrent_index'

export type ConcurrentIndexOutcome = 'ran' | 'skipped' | 'deferred'

type IndexTarget = Exclude<SchemaLockTarget, { kind: 'index-by-name' }>

// Session advisory lock: query and catalogQuery must share one session, as the untimed schema pool does.
// Only the lock holder drops an invalid index, so it can never be another director's build in progress.
export async function buildIndexConcurrently(input: {
  statement: string
  target: IndexTarget
  query: (statement: string) => Promise<unknown>
  catalogQuery: SchemaCatalogQuery
  eventPrefix: string
}): Promise<ConcurrentIndexOutcome> {
  const { statement, target, query, catalogQuery, eventPrefix } = input
  const log = (event: string, detail?: Record<string, unknown>): void =>
    console.log(JSON.stringify({ event: `${eventPrefix}_${event}`, name: target.name, ...detail }))

  const before = await catalogObjectPresence(catalogQuery, target)
  if (before.present && before.indisvalid === true) {
    log('object_present', { kind: target.kind, table: target.table, indisvalid: true })
    return 'skipped'
  }
  const locked = await catalogQuery(
    'SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS locked',
    [BUILDER_LOCK_KEY]
  )
  if (locked[0]?.locked !== true) {
    log('object_deferred', { detail: 'another director is building a concurrent index' })
    return 'deferred'
  }
  try {
    const presence = await catalogObjectPresence(catalogQuery, target)
    if (presence.present && presence.indisvalid === true) return 'skipped'
    // IF NOT EXISTS skips the invalid index an interrupted build leaves, so it must go first.
    if (presence.present && typeof presence.qualifiedName === 'string') {
      log('invalid_index_dropped')
      await query(`DROP INDEX CONCURRENTLY IF EXISTS ${presence.qualifiedName}`)
    }
    await query(statement)
    log('concurrent_index_built')
    return 'ran'
  } catch (error) {
    // Lock timeouts, deadlocks and cancels leave at most an invalid index, which the next boot rebuilds.
    console.warn(
      JSON.stringify({
        event: `${eventPrefix}_object_deferred`,
        code: String((error as { code?: unknown } | null)?.code),
        name: target.name,
        detail: 'concurrent index build failed; left for the next boot to rebuild'
      })
    )
    return 'deferred'
  } finally {
    await catalogQuery('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))', [
      BUILDER_LOCK_KEY
    ]).catch(() => undefined)
  }
}
