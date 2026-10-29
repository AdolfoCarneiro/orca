import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { parseHooksJsonText } from '../agent-hooks/hooks-json-read'
import type { NativeHookDestination } from '../agent-hooks/hooks-json-write-async'
import { getStatusLineSlotState } from './hook-settings'
import { existingStatusLineDestination, readSystemHookSettings } from './statusline-ownership'

export type StatusLineOwner = NativeHookDestination & { phase: 'managed' | 'own-change' }
export type OwnerObservation = 'managed' | 'removed' | 'missing' | 'displaced' | 'unknown'

export async function observeStatusLineOwner(owner: StatusLineOwner): Promise<OwnerObservation> {
  try {
    const parent = dirname(owner.path)
    if ((await realpath(parent)) !== parent) {
      return 'displaced'
    }
    const identity = await stat(parent, { bigint: true })
    if (
      !identity.isDirectory() ||
      String(identity.dev) !== owner.parent.dev ||
      String(identity.ino) !== owner.parent.ino
    ) {
      return 'displaced'
    }
    if ((await lstat(owner.path)).isSymbolicLink()) {
      return 'displaced'
    }
    const config = parseHooksJsonText(await readFile(owner.path, 'utf8'))
    return config
      ? getStatusLineSlotState(config) === 'managed'
        ? 'managed'
        : 'removed'
      : 'unknown'
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'missing'
      : 'unknown'
  }
}

let activeCohort: Promise<void> | undefined

// Timed-out filesystem calls retain the cohort and its two slots until they actually settle.
export async function inspectStatusLineHistory(
  owners: StatusLineOwner[],
  signal: AbortSignal,
  conventionalPath: string,
  timeoutMs = 2000
) {
  if (activeCohort) {
    throw new Error('Claude statusline history is still being inspected')
  }
  const observations = new Map<StatusLineOwner, OwnerObservation>()
  const admitted = new Set<StatusLineOwner>()
  let cursor = 0
  let stopped = false
  let witness: StatusLineOwner | undefined
  let migration: StatusLineOwner | undefined
  let admissions = 0
  const work = async () => {
    while (!stopped && !signal.aborted && cursor <= owners.length) {
      const index = cursor++
      admissions++
      if (index === owners.length) {
        try {
          const current = await readSystemHookSettings(conventionalPath)
          if (getStatusLineSlotState(current.config) === 'managed') {
            migration = {
              ...(await existingStatusLineDestination(conventionalPath)),
              phase: 'managed'
            }
          }
        } catch {
          /* Unobserved legacy success is not deletion evidence. */
        }
        continue
      }
      const owner = owners[index]
      admitted.add(owner)
      const result = await observeStatusLineOwner(owner)
      if (stopped || signal.aborted) {
        return
      }
      observations.set(owner, result)
      if (owner.phase === 'managed' && result === 'removed') {
        witness = owner
        stopped = true
      }
      await yieldTurn()
    }
  }
  const cohort = Promise.all([work(), work()]).then(() => {})
  activeCohort = cohort
  void cohort.finally(() => {
    if (activeCohort === cohort) {
      activeCohort = undefined
    }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    await Promise.race([
      cohort,
      new Promise<void>((resolve) => {
        abort = resolve
        signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(resolve, timeoutMs)
      })
    ])
    signal.throwIfAborted()
    for (const owner of admitted) {
      if (!observations.has(owner)) {
        observations.set(owner, 'unknown')
      }
    }
    if (!witness && admissions !== owners.length + 1) {
      throw new Error('Claude statusline history inspection is incomplete')
    }
    return { witness, migration, observations, complete: admissions === owners.length + 1 }
  } finally {
    stopped = true
    if (timer) {
      clearTimeout(timer)
    }
    if (abort) {
      signal.removeEventListener('abort', abort)
    }
  }
}
