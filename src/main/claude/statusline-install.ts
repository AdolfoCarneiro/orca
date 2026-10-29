import { homedir } from 'node:os'
import { rm } from 'node:fs/promises'
import { writeManagedScript, type HooksConfig } from '../agent-hooks/installer-utils'
import {
  writeHooksJsonAsync,
  type NativeHookDestination
} from '../agent-hooks/hooks-json-write-async'
import { getManagedStatusLineCommand, getManagedStatusLineScript } from './statusline-script'
import {
  applyManagedStatusLine,
  CLAUDE_HOOK_SETTINGS,
  getConfigPath,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  removeManagedStatusLine,
  removeManagedHooks,
  getManagedScriptFileName
} from './hook-settings'
import { inspectStatusLineHistory, observeStatusLineOwner } from './statusline-history'
import {
  readSystemHookSettings,
  sameStatusLineDestination,
  withClaudeSystemScope
} from './statusline-ownership'
import type { ClaudeManagedHookPlan } from './claude-managed-hook-events'

type SystemOperation = { signal?: AbortSignal; shouldContinue?: () => boolean }
const operations = new Map<string, AbortController>()

function request(home: string, options: SystemOperation) {
  operations.get(home)?.abort()
  const controller = new AbortController()
  operations.set(home, controller)
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const check = () => {
    signal.throwIfAborted()
    if (options.shouldContinue?.() === false) {
      throw new Error('Claude hook installation was canceled')
    }
  }
  return {
    signal,
    check,
    finish: () => {
      if (operations.get(home) === controller) {
        operations.delete(home)
      }
    }
  }
}

function managed(config: HooksConfig) {
  const path = getStatusLineScriptPath()
  writeManagedScript(path, getManagedStatusLineScript('local'))
  return applyManagedStatusLine(
    config,
    getManagedStatusLineCommand(path),
    getStatusLineScriptFileName()
  )
}

export async function installClaudeSystemHooks(
  path: string,
  plan: ClaudeManagedHookPlan,
  mergeEvents: (config: HooksConfig) => HooksConfig,
  options: SystemOperation = {}
) {
  const home = homedir()
  const started = Date.now()
  const invocation = request(home, options)
  const admission = AbortSignal.any([invocation.signal, AbortSignal.timeout(2000)])
  try {
    const snapshot = await withClaudeSystemScope(home, admission, async (store) => {
      invocation.check()
      const current = await readSystemHookSettings(path)
      const slot = getStatusLineSlotState(current.config)
      let next = mergeEvents(current.config)
      if (slot === 'user') {
        await writeHooksJsonAsync(path, next, { beforePublish: async () => invocation.check() })
        return null
      }
      if (plan.statusLine === 'install' && slot === 'managed') {
        next = managed(next)
      }
      try {
        await store.read()
      } catch (error) {
        if (current.raw !== null) {
          await writeHooksJsonAsync(path, next, { beforePublish: async () => invocation.check() })
        }
        throw error
      }
      if (plan.statusLine === 'retire') {
        next = removeManagedStatusLine(next, getStatusLineScriptFileName()).config
      }
      let destination: NativeHookDestination | undefined
      await writeHooksJsonAsync(path, next, {
        beforePublish: async (selected) => {
          invocation.check()
          destination = selected
          const owner = store.document.destinations.find((entry) =>
            sameStatusLineDestination(entry, selected)
          )
          if (
            owner?.phase === 'managed' &&
            (current.raw === null || (slot === 'managed' && plan.statusLine === 'retire'))
          ) {
            await store.set(selected, 'own-change')
            try {
              invocation.check()
            } catch (error) {
              await store.set(selected, 'managed')
              throw error
            }
          }
          invocation.check()
        }
      })
      if (!destination) {
        throw new Error('Claude settings publication destination is unavailable')
      }
      const published = destination
      const owner = store.document.destinations.find((entry) =>
        sameStatusLineDestination(entry, published)
      )
      if (slot === 'managed' && plan.statusLine === 'install') {
        if ((await observeStatusLineOwner({ ...destination, phase: 'managed' })) !== 'managed') {
          throw new Error('Claude callback publication could not be verified')
        }
        await store.set(destination, 'managed')
        return null
      }
      if (owner?.phase === 'own-change') {
        await store.set(destination)
      }
      if (plan.statusLine !== 'install' || (current.raw !== null && owner?.phase === 'managed')) {
        return null
      }
      return store.document
    })
    if (!snapshot) {
      return
    }
    invocation.check()
    const remaining = 2000 - (Date.now() - started)
    if (remaining <= 0) {
      throw new Error('Claude statusline evidence admission timed out')
    }
    const history = await inspectStatusLineHistory(
      snapshot.destinations,
      invocation.signal,
      getConfigPath(CLAUDE_HOOK_SETTINGS),
      remaining
    )
    await withClaudeSystemScope(
      home,
      AbortSignal.any([invocation.signal, AbortSignal.timeout(250)]),
      async (store) => {
        invocation.check()
        await store.read()
        if (store.document.revision !== snapshot.revision) {
          throw new Error('Claude statusline ownership changed during inspection')
        }
        const current = await readSystemHookSettings(path)
        const slot = getStatusLineSlotState(current.config)
        if (slot === 'user') {
          await writeHooksJsonAsync(path, mergeEvents(current.config), {
            beforePublish: async () => invocation.check()
          })
          return
        }
        let suppress = false
        if (history.witness) {
          suppress = (await observeStatusLineOwner(history.witness)) === 'removed'
          if (!suppress && !history.complete) {
            throw new Error('Claude statusline deletion evidence changed during inspection')
          }
        }
        const recovered = new Map(store.document.destinations.map((owner) => [owner.path, owner]))
        for (const [owner, observed] of history.observations) {
          invocation.check()
          if (owner.phase !== 'own-change' || observed === 'unknown') {
            continue
          }
          const fresh = await observeStatusLineOwner(owner)
          if (fresh === 'managed') {
            recovered.set(owner.path, { ...owner, phase: 'managed' })
          } else if (fresh !== 'unknown') {
            recovered.delete(owner.path)
          }
        }
        if (
          history.migration &&
          !recovered.has(history.migration.path) &&
          (await observeStatusLineOwner(history.migration)) === 'managed'
        ) {
          recovered.set(history.migration.path, history.migration)
        }
        invocation.check()
        await store.save([...recovered.values()])
        if (slot === 'empty' && suppress) {
          return
        }
        invocation.check()
        const next = managed(mergeEvents(current.config))
        let destination: NativeHookDestination | undefined
        await writeHooksJsonAsync(path, next, {
          beforePublish: async (selected) => {
            invocation.check()
            destination = selected
          }
        })
        if (
          !destination ||
          (await observeStatusLineOwner({ ...destination, phase: 'managed' })) !== 'managed'
        ) {
          throw new Error('Claude callback publication could not be verified')
        }
        await store.set(destination, 'managed')
      }
    )
  } finally {
    invocation.finish()
  }
}

export async function removeClaudeSystemHooks(path: string, options: SystemOperation = {}) {
  const home = homedir()
  const invocation = request(home, options)
  try {
    await withClaudeSystemScope(
      home,
      AbortSignal.any([invocation.signal, AbortSignal.timeout(2000)]),
      async (store) => {
        invocation.check()
        await store.save([], true)
        const errors: string[] = []
        for (const target of new Set([path, getConfigPath(CLAUDE_HOOK_SETTINGS)])) {
          try {
            const current = await readSystemHookSettings(target)
            if (current.raw === null) {
              continue
            }
            const events = removeManagedHooks(current.config, getManagedScriptFileName()).config
            const next = removeManagedStatusLine(events, getStatusLineScriptFileName()).config
            await writeHooksJsonAsync(target, next, {
              beforePublish: async () => invocation.check()
            })
          } catch (error) {
            errors.push(String(error))
          }
        }
        await rm(getStatusLineInstallMarkerPath(), { force: true }).catch((error: unknown) =>
          errors.push(String(error))
        )
        if (errors.length) {
          throw new Error(errors.join('; '))
        }
      }
    )
  } finally {
    invocation.finish()
  }
}
