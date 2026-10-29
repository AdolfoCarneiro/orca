/* eslint-disable max-lines -- Why: pending fields, read retirement and drain share one publication lifecycle; keep their settlement order together. */
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCollectionResult,
  LinearWorkspace
} from '../../../../../shared/linear/workspace-types'
import type { LinearReadScope } from './linear-slice-scope'

export type LinearIssueData =
  | LinearIssue
  | null
  | LinearIssue[]
  | LinearCollectionResult<LinearIssue>
type Field =
  | 'state'
  | 'priority'
  | 'estimate'
  | 'assignee'
  | 'labels'
  | 'title'
  | 'description'
  | 'project'
type Delta = Partial<LinearIssue>
type Contribution = { operation?: object; value: Delta }
type FieldGroup = { base: Delta; contributions: Contribution[] }
type IssueOwner = {
  id: string
  workspaceId?: string
  organizationId?: string
  fields: Map<Field, FieldGroup>
}
export const pendingLinearIssueWrites = new Map<string, Map<string, IssueOwner>>()
export type LinearIssuePublication = {
  <T extends Delta>(previous: T): T
  fields: readonly Field[]
  patch: Delta
  current: (field: string) => boolean
}
type LocalConsumer = {
  tokens: Map<Field, object>
  publish: (apply: LinearIssuePublication) => void
}
const localConsumers = new Map<string, Map<string, Set<LocalConsumer>>>()
type IssueReadLifecycle = {
  scope: LinearReadScope
  edge: (id: string, confirmed?: boolean) => void
  patch: (id: string, patch: Delta) => void
  drain: () => void
  invalidate: (
    identifier?: string,
    workspaceId?: string | null,
    affectedWorkspaces?: ReadonlySet<string>
  ) => void
  abandon: () => void
}
const reads = new Map<string, Set<IssueReadLifecycle>>()
function scopedReads(scope: LinearReadScope) {
  return reads.get(scope.contextKey) ?? []
}
function notifyPublication(publish: () => void) {
  try {
    publish()
  } catch (error) {
    console.warn('[linear] issue publication failed:', error)
  }
}
const fields: Field[] = [
  'state',
  'priority',
  'estimate',
  'assignee',
  'labels',
  'title',
  'description'
]

function fieldValue(issue: Delta, field: Field): Delta {
  return field === 'labels'
    ? { labels: issue.labels, labelIds: issue.labelIds }
    : { [field]: issue[field] }
}
function value(group: FieldGroup): Delta {
  return group.contributions.at(-1)?.value ?? group.base
}
function ownerMap(scope: LinearReadScope) {
  return pendingLinearIssueWrites.get(scope.contextKey)
}
export function knownLinearOrganization(
  workspace: LinearWorkspace | undefined
): string | undefined {
  return workspace?.isLegacy && workspace.organizationId === workspace.id
    ? undefined
    : workspace?.organizationId
}
export function projectLinearIssue(scope: LinearReadScope, issue: LinearIssue): LinearIssue {
  const owner = ownerMap(scope)?.get(issue.id)
  if (!owner) {
    return issue
  }
  const patch = Object.assign({}, ...[...owner.fields.values()].map(value))
  return { ...issue, ...patch }
}
export function registerLinearIssueConsumer(
  scope: LinearReadScope,
  id: string,
  publish: LocalConsumer['publish']
): { release: () => void; capture: () => () => void } {
  let byIssue = localConsumers.get(scope.contextKey)
  if (!byIssue) {
    byIssue = new Map()
    localConsumers.set(scope.contextKey, byIssue)
  }
  let consumers = byIssue.get(id)
  if (!consumers) {
    consumers = new Set()
    byIssue.set(id, consumers)
  }
  const consumer: LocalConsumer = { tokens: new Map(), publish }
  consumers.add(consumer)
  const owner = ownerMap(scope)?.get(id)
  if (owner) {
    publishConsumer(consumer, Object.assign({}, ...[...owner.fields.values()].map(value)))
  }
  return {
    capture: () => {
      const captured = [...consumer.tokens]
      return () => {
        for (const [field, token] of captured) {
          if (consumer.tokens.get(field) === token) {
            consumer.tokens.delete(field)
          }
        }
      }
    },
    release: () => {
      consumer.tokens.clear()
      consumers.delete(consumer)
      if (!consumers.size) {
        byIssue.delete(id)
      }
      if (!byIssue.size) {
        localConsumers.delete(scope.contextKey)
      }
    }
  }
}
function publishConsumer(consumer: LocalConsumer, patch: Delta) {
  const token = {}
  const changed = [...fields, 'project' as const].filter((field) => Object.hasOwn(patch, field))
  for (const field of changed) {
    consumer.tokens.set(field, token)
  }
  const apply = <T extends Delta>(previous: T): T => {
    const current = changed.filter((field) => consumer.tokens.get(field) === token)
    return current.length
      ? { ...previous, ...Object.assign({}, ...current.map((field) => fieldValue(patch, field))) }
      : previous
  }
  notifyPublication(() =>
    consumer.publish(
      Object.assign(apply, {
        fields: changed,
        patch,
        current: (field: string) =>
          changed.some((key) => key === field && consumer.tokens.get(key) === token)
      })
    )
  )
}
function publishLocal(scope: LinearReadScope, id: string, patch: Delta) {
  for (const consumer of localConsumers.get(scope.contextKey)?.get(id) ?? []) {
    publishConsumer(consumer, patch)
  }
}

function retire(scope: LinearReadScope, id: string, confirmed = false) {
  for (const read of scopedReads(scope)) {
    notifyPublication(() => read.edge(id, confirmed))
  }
}

export function confirmLinearIssueWrite(args: {
  scope: LinearReadScope
  id: string
  patch?: Delta
  publish?: () => void
}) {
  if (!args.scope.isCurrentRuntime()) {
    return
  }
  retire(args.scope, args.id, true)
  try {
    if (args.publish) {
      notifyPublication(args.publish)
    }
    if (args.patch) {
      publishLocal(args.scope, args.id, args.patch)
    }
  } finally {
    for (const read of scopedReads(args.scope)) {
      notifyPublication(() => read.drain())
    }
  }
}

export async function runLinearIssueWrite<T extends { ok: boolean }>(args: {
  scope: LinearReadScope
  issue: LinearIssue
  patch: Delta
  organizationId?: string
  publish: (patch: Delta) => void
  mutate: () => Promise<T>
}): Promise<T> {
  const { scope, issue, patch } = args
  let byIssue = ownerMap(scope)
  if (!byIssue) {
    byIssue = new Map()
    pendingLinearIssueWrites.set(scope.contextKey, byIssue)
  }
  let owner = byIssue.get(issue.id)
  if (!owner) {
    owner = {
      id: issue.id,
      workspaceId: issue.workspaceId,
      organizationId: args.organizationId,
      fields: new Map()
    }
    byIssue.set(issue.id, owner)
  }
  const operation = {}
  const enrolled: FieldGroup[] = []
  for (const field of fields) {
    if (!Object.hasOwn(patch, field)) {
      continue
    }
    let group = owner.fields.get(field)
    if (!group) {
      group = { base: fieldValue(issue, field), contributions: [] }
      owner.fields.set(field, group)
    }
    group.contributions.push({ operation, value: fieldValue(patch, field) })
    enrolled.push(group)
  }
  let succeeded = false
  try {
    retire(scope, issue.id)
    notifyPublication(() => args.publish(patch))
    publishLocal(scope, issue.id, patch)
    const result = await args.mutate()
    succeeded = result.ok
    return result
  } finally {
    const attached =
      pendingLinearIssueWrites.get(scope.contextKey) === byIssue && scope.isCurrentRuntime()
    if (attached) {
      retire(scope, issue.id)
    }
    const delta: Delta = {}
    for (const [field, group] of owner.fields) {
      if (!enrolled.includes(group)) {
        continue
      }
      const index = group.contributions.findIndex((entry) => entry.operation === operation)
      if (index === -1) {
        continue
      }
      if (succeeded && !group.contributions.slice(index + 1).some((entry) => !entry.operation)) {
        group.contributions[index] = { value: group.contributions[index].value }
        group.contributions = group.contributions.filter(
          (entry, position) => entry.operation || position === index
        )
      } else {
        group.contributions.splice(index, 1)
      }
      Object.assign(delta, value(group))
      if (!group.contributions.some((entry) => entry.operation)) {
        owner.fields.delete(field)
      }
    }
    if (!owner.fields.size) {
      byIssue.delete(issue.id)
    }
    if (!byIssue.size && pendingLinearIssueWrites.get(scope.contextKey) === byIssue) {
      pendingLinearIssueWrites.delete(scope.contextKey)
    }
    try {
      if (attached) {
        notifyPublication(() => args.publish(delta))
        publishLocal(scope, issue.id, delta)
      }
    } finally {
      if (attached) {
        for (const read of scopedReads(scope)) {
          notifyPublication(() => read.drain())
        }
      }
    }
  }
}

export type LinearIssueView<T> =
  | { kind: 'loading'; data: T | null }
  | { kind: 'data'; data: T }
  | { kind: 'error'; error: unknown; data: T | null }
  | { kind: 'abandoned'; data: null }
export type LinearIssueLease<T> = {
  currentView: () => LinearIssueView<T>
  subscribe: (notify: () => void) => () => void
  commit: <S>(
    view: LinearIssueView<T>,
    previous: S,
    reduce: (previous: S, data: T | null) => S
  ) => S
  waitForCurrentTerminal: () => Promise<LinearIssueView<T>>
  release: () => void
}
export type LinearIssueRead<T> = { acquire: (isLive?: () => boolean) => LinearIssueLease<T> }
export type LinearIssueRequest<T> = LinearIssueRead<T> & {
  force: () => void
  abandon: () => void
  contextKey: string
}

function rows(data: LinearIssueData): LinearIssue[] {
  return data === null ? [] : Array.isArray(data) ? data : 'items' in data ? data.items : [data]
}
function replaceRows<T extends LinearIssueData>(data: T, items: LinearIssue[]): T {
  // SAFETY: the adapter preserves the exact input container shape.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter preserves the input container family; generic T cannot be narrowed by its runtime array/items/null discriminant.
  return (
    data === null
      ? (items[0] ?? null)
      : Array.isArray(data)
        ? items
        : 'items' in data
          ? { ...data, items }
          : (items[0] ?? null)
  ) as T
}
function occurrence(issue: LinearIssue) {
  return JSON.stringify([issue.workspaceId, issue.id])
}

export function openLinearIssueRead<T extends LinearIssueData>(args: {
  scope: LinearReadScope
  workspaceId?: string | null
  identifier?: string
  workspaces?: LinearWorkspace[]
  seed: T | null
  cached?: T
  dispatch: (force: boolean) => Promise<T>
  publish: (data: T) => void
  isCurrent: () => boolean
  remove: () => void
  onSettled?: (data: T | undefined, error?: unknown) => void
}): LinearIssueRead<T> & { force: () => void; abandon: () => void; contextKey: string } {
  let view: LinearIssueView<T> = { kind: 'loading', data: args.seed }
  let warm = args.seed
  let attempt: object | null = null
  let active = true
  let needsReplacement = false
  const consumers = new Map<() => void, () => boolean>()
  const notify = () => {
    // oxlint-disable-next-line unicorn/no-useless-spread -- Why: callbacks can release or acquire demand during notification.
    for (const listener of [...consumers.keys()]) {
      notifyPublication(listener)
    }
  }
  const organizations = new Map(
    args.workspaces?.map((workspace) => [workspace.id, knownLinearOrganization(workspace)])
  )
  const queryOrg = args.workspaceId ? organizations.get(args.workspaceId) : undefined
  const knownId = () => (args.identifier ? rows(warm)[0]?.id : undefined)
  const compatible = (owner: IssueOwner) => {
    const detailId = knownId()
    if (detailId) {
      return owner.id === detailId
    }
    if (args.identifier && owner.id === args.identifier) {
      return true
    }
    const ownerOrg =
      owner.organizationId ?? (owner.workspaceId ? organizations.get(owner.workspaceId) : undefined)
    return !queryOrg || !ownerOrg || queryOrg === ownerOrg
  }
  function* candidates(): Generator<IssueOwner> {
    const all = ownerMap(args.scope)
    const detailId = knownId()
    if (detailId) {
      const owner = all?.get(detailId)
      if (owner) {
        yield owner
      }
    } else if (all) {
      for (const owner of all.values()) {
        if (compatible(owner)) {
          yield owner
        }
      }
    }
  }
  const hasCandidates = () => !candidates().next().done
  const reconcile = (data: T): T | null => {
    const pending = [...candidates()]
    if (!pending.length) {
      return data
    }
    const returned = rows(data)
    if (args.identifier && returned.length) {
      return replaceRows(
        data,
        returned.map((row) => projectLinearIssue(args.scope, row))
      )
    }
    const present = new Set(returned.map(occurrence))
    const previous = rows(warm)
    const protectedMissing = previous.filter(
      (row) => !present.has(occurrence(row)) && ownerMap(args.scope)?.has(row.id)
    )
    const known = new Set([...returned, ...previous].map((row) => row.id))
    const uncertain = pending.some((owner) => !known.has(owner.id))
    if (uncertain && !(data && !Array.isArray(data) && 'errors' in data && data.errors?.length)) {
      return null
    }
    const projected = returned.map((row) => projectLinearIssue(args.scope, row))
    if (!protectedMissing.length) {
      return replaceRows(data, projected)
    }
    const missing = new Set(protectedMissing)
    const merged: LinearIssue[] = []
    let next = 0
    for (let i = 0; i < previous.length && (next < projected.length || missing.size); i++) {
      const prior = previous[i]
      if (missing.delete(prior)) {
        merged.push(projectLinearIssue(args.scope, prior))
      } else if (next < projected.length) {
        merged.push(projected[next++])
      }
    }
    merged.push(...projected.slice(next))
    return replaceRows(data ?? warm, merged)
  }
  const abandon = () => {
    if (!active) {
      return
    }
    active = false
    attempt = null
    view = { kind: 'abandoned', data: null }
    const scoped = reads.get(args.scope.contextKey)
    scoped?.delete(lifecycle)
    if (!scoped?.size) {
      reads.delete(args.scope.contextKey)
    }
    args.remove()
    notify()
  }
  const start = (force = true) => {
    if (!active || !args.isCurrent()) {
      abandon()
      return
    }
    const token = {}
    attempt = token
    needsReplacement = false
    view = { kind: 'loading', data: warm }
    notify()
    void args.dispatch(force).then(
      (data) => {
        if (!active || attempt !== token) {
          return
        }
        if (!args.isCurrent()) {
          abandon()
          return
        }
        const reconciled = reconcile(data)
        attempt = null
        if (reconciled === null && hasCandidates()) {
          needsReplacement = true
          view = { kind: 'loading', data: warm }
          notify()
          return
        }
        const published = reconciled ?? data
        warm = published
        needsReplacement = hasCandidates()
        view = { kind: 'data', data: published }
        notifyPublication(() => args.publish(published))
        notify()
        notifyPublication(() => args.onSettled?.(published))
      },
      (error: unknown) => {
        if (!active || attempt !== token) {
          return
        }
        if (!args.isCurrent()) {
          abandon()
          return
        }
        attempt = null
        needsReplacement = false
        view = { kind: 'error', error, data: warm }
        notify()
        notifyPublication(() => args.onSettled?.(undefined, error))
      }
    )
  }
  const lifecycle = {
    scope: args.scope,
    patch: (id: string, patch: Delta) => {
      if (view.kind === 'abandoned' || warm === null || !rows(warm).some((row) => row.id === id)) {
        return
      }
      warm = replaceRows(
        warm,
        rows(warm).map((row) => (row.id === id ? { ...row, ...patch } : row))
      )
      view = { ...view, data: warm }
      notify()
    },
    edge: (id: string, confirmed = false) => {
      if (!active) {
        return
      }
      if (confirmed) {
        const known = args.identifier ? rows(warm)[0] : undefined
        if (known && known.id !== id) {
          return
        }
      } else {
        const owner = ownerMap(args.scope)?.get(id)
        if (!owner || !compatible(owner)) {
          return
        }
      }
      attempt = null
      needsReplacement = true
      if (warm !== null) {
        warm = replaceRows(
          warm,
          rows(warm).map((row) => projectLinearIssue(args.scope, row))
        )
      }
      view =
        warm !== null
          ? view.kind === 'error'
            ? { ...view, data: warm }
            : { kind: 'data', data: warm }
          : { kind: 'loading', data: null }
      notify()
    },
    drain: () => {
      if (needsReplacement && !hasCandidates()) {
        if ([...consumers.values()].some((current) => current())) {
          start()
        } else {
          abandon()
        }
      }
    },
    invalidate: (
      identifier?: string,
      workspaceId?: string | null,
      affectedWorkspaces?: ReadonlySet<string>
    ) => {
      if (
        affectedWorkspaces &&
        args.workspaceId !== 'all' &&
        !affectedWorkspaces.has(args.workspaceId ?? 'default') &&
        !(args.workspaceId == null && affectedWorkspaces.has('selected'))
      ) {
        return
      }
      if (identifier && args.identifier) {
        // Cold equal lookups can be affected too; the exact detail is forced by its caller.
        const organization = workspaceId ? organizations.get(workspaceId) : undefined
        if (
          (args.identifier === identifier &&
            (args.workspaceId ?? null) === (workspaceId ?? null)) ||
          (queryOrg && organization && queryOrg !== organization) ||
          (args.identifier !== identifier &&
            !rows(warm).some((row) => row.id === identifier || row.identifier === identifier))
        ) {
          return
        }
      }
      if ([...consumers.values()].some((current) => current())) {
        start()
      } else {
        abandon()
      }
    },
    abandon
  }
  let scoped = reads.get(args.scope.contextKey)
  if (!scoped) {
    scoped = new Set()
    reads.set(args.scope.contextKey, scoped)
  }
  scoped.add(lifecycle)
  const read = {
    contextKey: args.scope.contextKey,
    force: start,
    abandon,
    acquire: (isLive = () => true): LinearIssueLease<T> => {
      let live = true
      const listeners = new Set<() => void>()
      const signal = () => {
        for (const listener of listeners) {
          notifyPublication(listener)
        }
      }
      const current = () => live && active && isLive() && args.isCurrent()
      consumers.set(signal, current)
      const lease: LinearIssueLease<T> = {
        currentView: () => (current() ? view : { kind: 'abandoned', data: null }),
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        commit: (expected, previous, reduce) =>
          current() && view === expected ? reduce(previous, expected.data) : previous,
        waitForCurrentTerminal: () =>
          new Promise((resolve) => {
            const finish = () => {
              const latest = lease.currentView()
              if (latest.kind === 'loading') {
                return
              }
              listeners.delete(finish)
              resolve(latest)
            }
            listeners.add(finish)
            finish()
          }),
        release: () => {
          live = false
          signal()
          listeners.clear()
          consumers.delete(signal)
          if (!consumers.size) {
            abandon()
          }
        }
      }
      return lease
    }
  }
  if (args.cached === undefined) {
    start(false)
  } else {
    const reconciled = reconcile(args.cached)
    needsReplacement = hasCandidates()
    warm = reconciled ?? args.cached
    view =
      reconciled === null && needsReplacement
        ? { kind: 'loading', data: warm }
        : { kind: 'data', data: reconciled ?? args.cached }
  }
  return read
}

export function detachLinearIssuePublication(scope: LinearReadScope, allSources = false) {
  const affected = (key: string) =>
    key === scope.contextKey ||
    (allSources &&
      (key === scope.runtimeContextKey || key.startsWith(`${scope.runtimeContextKey}::`)))
  for (const key of pendingLinearIssueWrites.keys()) {
    if (affected(key)) {
      pendingLinearIssueWrites.delete(key)
    }
  }
  for (const [key, byIssue] of localConsumers) {
    if (!affected(key)) {
      continue
    }
    for (const consumers of byIssue.values()) {
      for (const consumer of consumers) {
        consumer.tokens.clear()
      }
    }
  }
  // oxlint-disable-next-line unicorn/no-useless-spread -- Why: abandonment callbacks can replace demand while old scopes are removed.
  for (const [key, scoped] of [...reads]) {
    if (affected(key)) {
      // oxlint-disable-next-line unicorn/no-useless-spread -- Why: abandon can synchronously replace demand.
      for (const read of [...scoped]) {
        read.abandon()
      }
    }
  }
}

export function abandonLinearIssueReads() {
  // oxlint-disable-next-line unicorn/no-useless-spread -- Why: callbacks can synchronously register replacement scopes.
  for (const scoped of [...reads.values()]) {
    // oxlint-disable-next-line unicorn/no-useless-spread -- Why: callbacks can synchronously register replacement demand.
    for (const read of [...scoped]) {
      read.abandon()
    }
  }
}

export function publishLinearIssuePatch(scope: LinearReadScope, id: string, patch: Delta) {
  for (const read of scopedReads(scope)) {
    read.patch(id, patch)
  }
}

export function invalidateLinearIssueReads(
  scope: LinearReadScope,
  identifier?: string,
  allSources = false,
  workspaceId?: string | null,
  affectedWorkspaces?: ReadonlySet<string>
) {
  const affected = allSources
    ? [...reads.values()].filter(
        (scoped) =>
          scoped.values().next().value?.scope.runtimeContextKey === scope.runtimeContextKey
      )
    : [scopedReads(scope)]
  for (const scoped of affected) {
    // oxlint-disable-next-line unicorn/no-useless-spread -- Why: refresh callbacks can replace demand.
    for (const read of [...scoped]) {
      read.invalidate(identifier, workspaceId, affectedWorkspaces)
    }
  }
}

export function observeLinearIssueRead<T>(
  read: LinearIssueRead<T>,
  isLive: () => boolean,
  publish: (lease: LinearIssueLease<T>, view: LinearIssueView<T>) => void
): () => void {
  const lease = read.acquire(isLive)
  const update = () => publish(lease, lease.currentView())
  const unsubscribe = lease.subscribe(update)
  update()
  return () => {
    unsubscribe()
    lease.release()
  }
}

export async function consumeLinearIssueRead<T>(
  read: LinearIssueRead<T>,
  isLive = () => true,
  consume?: (data: T | null, lease: LinearIssueLease<T>, view: LinearIssueView<T>) => void,
  signal?: AbortSignal
): Promise<void> {
  const lease = read.acquire(() => !signal?.aborted && isLive())
  const abort = () => lease.release()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const view = await lease.waitForCurrentTerminal()
    if (view.kind === 'abandoned') {
      return
    }
    if (view.kind === 'error') {
      throw view.error
    }
    lease.commit(view, undefined, () => {
      consume?.(view.data, lease, view)
      return undefined
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    lease.release()
  }
}

export function mapLinearIssueRead<T, U>(
  read: LinearIssueRead<T>,
  map: (data: T) => U,
  onError?: (error: unknown) => U
): LinearIssueRead<U> {
  return {
    acquire: (isLive) => {
      const lease = read.acquire(isLive)
      let original: LinearIssueView<T> | undefined
      let mapped: LinearIssueView<U> = { kind: 'abandoned', data: null }
      const currentView = (): LinearIssueView<U> => {
        const next = lease.currentView()
        if (original !== next) {
          original = next
          mapped =
            next.kind === 'abandoned'
              ? next
              : next.kind === 'error' && onError
                ? { kind: 'data', data: onError(next.error) }
                : next.kind === 'data'
                  ? { kind: 'data', data: map(next.data) }
                  : { ...next, data: next.data === null ? null : map(next.data) }
        }
        return mapped
      }
      return {
        currentView,
        subscribe: lease.subscribe,
        release: lease.release,
        commit: (view, previous, reduce) =>
          view === currentView() && original
            ? lease.commit(original, previous, () => reduce(previous, view.data))
            : previous,
        waitForCurrentTerminal: async () => {
          await lease.waitForCurrentTerminal()
          while (currentView().kind === 'loading') {
            await lease.waitForCurrentTerminal()
          }
          return currentView()
        }
      }
    }
  }
}
