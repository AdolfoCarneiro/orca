import { homedir } from 'node:os'
import { lstat, rm } from 'node:fs/promises'
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
import {
  readSystemHookSettings,
  readStatusLineEvidence,
  selectedStatusLineDestination,
  existingStatusLineDestination,
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
  const invocation = request(home, options)
  const admission = AbortSignal.any([invocation.signal, AbortSignal.timeout(2000)])
  try {
    await withClaudeSystemScope(
      home,
      admission,
      async (ownership) => {
        invocation.check()
        const current = await readSystemHookSettings(path)
        let selectedPath = path
        if (current.raw !== null) {
          await writeHooksJsonAsync(path, mergeEvents(current.config), {
            beforePublish: async (selected) => {
              invocation.check()
              selectedPath = selected
            }
          })
          if (getStatusLineSlotState(current.config) === 'user') {
            return
          }
        }
        const store = ownership()
        const inspect = async (selected: string) =>
          await readStatusLineEvidence(admission, async () => {
            await store.read()
            return await selectedStatusLineDestination(selected)
          })
        let destination: NativeHookDestination
        if (current.raw === null) {
          invocation.check()
          const events = mergeEvents(current.config)
          const next = plan.statusLine === 'install' ? managed(events) : events
          await writeHooksJsonAsync(path, next, {
            beforePublish: async (selected) => {
              destination = await inspect(selected)
              invocation.check()
              const owner = store.document.destinations.find((entry) =>
                sameStatusLineDestination(entry, destination)
              )
              if (owner?.phase === 'managed') {
                await store.set(destination, 'own-change')
              }
              invocation.check()
            }
          })
        } else {
          destination = await inspect(selectedPath)
          // Read fresh after optional evidence, inside the same real mutation scope.
          const fresh = await readStatusLineEvidence(admission, () =>
            readSystemHookSettings(destination.path)
          )
          invocation.check()
          if (fresh.raw === null) {
            throw new Error('Claude settings disappeared during installation')
          }
          const slot = getStatusLineSlotState(fresh.config)
          if (slot === 'user') {
            return
          }
          const owner = store.document.destinations.find((entry) =>
            sameStatusLineDestination(entry, destination)
          )
          if (slot === 'empty' && owner?.phase === 'managed') {
            return
          }
          let next = mergeEvents(fresh.config)
          if (plan.statusLine === 'install') {
            next = managed(next)
          } else if (plan.statusLine === 'retire' && slot === 'managed') {
            await store.set(destination, 'own-change')
            next = removeManagedStatusLine(next, getStatusLineScriptFileName()).config
          }
          invocation.check()
          await writeHooksJsonAsync(destination.path, next, {
            beforePublish: async (selected) => {
              invocation.check()
              const actual = await readStatusLineEvidence(admission, () =>
                selectedStatusLineDestination(selected)
              )
              if (!sameStatusLineDestination(destination, actual)) {
                throw new Error('Claude settings destination changed')
              }
              invocation.check()
            }
          })
        }
        if (plan.statusLine === 'install') {
          // Publication has begun: join physical readback/receipt through real completion.
          const published = await selectedStatusLineDestination(destination!.path)
          if ((await lstat(published.path)).isSymbolicLink()) {
            throw new Error('Claude callback destination changed after publication')
          }
          const verified = await readSystemHookSettings(published.path)
          if (
            !sameStatusLineDestination(destination!, published) ||
            getStatusLineSlotState(verified.config) !== 'managed'
          ) {
            throw new Error('Claude callback publication could not be verified')
          }
          await store.set(published, 'managed')
        } else {
          const owner = store.document.destinations.find((entry) =>
            sameStatusLineDestination(entry, destination!)
          )
          if (owner?.phase === 'own-change') {
            await store.set(destination!)
          }
        }
      },
      invocation.check
    )
  } finally {
    invocation.finish()
  }
}

export async function removeClaudeSystemHooks(path: string, options: SystemOperation = {}) {
  const home = homedir()
  const invocation = request(home, options)
  const admission = AbortSignal.any([invocation.signal, AbortSignal.timeout(2000)])
  try {
    await withClaudeSystemScope(
      home,
      admission,
      async (ownership) => {
        const errors: string[] = []
        const targets = new Set([path, getConfigPath(CLAUDE_HOOK_SETTINGS)])
        // Event teardown is independent of optional callback authority at both known targets.
        for (const target of targets) {
          try {
            invocation.check()
            const current = await readSystemHookSettings(target)
            if (current.raw === null) {
              continue
            }
            const events = removeManagedHooks(current.config, getManagedScriptFileName())
            if (events.changed) {
              await writeHooksJsonAsync(target, events.config, {
                beforePublish: async () => invocation.check()
              })
            }
          } catch (error) {
            errors.push(String(error))
          }
        }
        try {
          const store = ownership()
          const destinations: NativeHookDestination[] = []
          await readStatusLineEvidence(admission, async () => {
            await store.read()
            for (const target of targets) {
              try {
                const selected = await existingStatusLineDestination(target)
                if (selected) {
                  destinations.push(selected)
                }
              } catch (error) {
                errors.push(String(error))
              }
            }
          })
          invocation.check()
          await store.save(
            store.document.destinations.filter(
              (owner) =>
                !destinations.some((selected) => sameStatusLineDestination(owner, selected))
            ),
            true
          )
          for (const selected of destinations) {
            try {
              invocation.check()
              const fresh = await readSystemHookSettings(selected.path)
              if (fresh.raw === null) {
                continue
              }
              const events = removeManagedHooks(fresh.config, getManagedScriptFileName())
              const callback = removeManagedStatusLine(events.config, getStatusLineScriptFileName())
              if (events.changed || callback.changed) {
                await writeHooksJsonAsync(selected.path, callback.config, {
                  beforePublish: async (writePath) => {
                    invocation.check()
                    const actual = await readStatusLineEvidence(admission, () =>
                      selectedStatusLineDestination(writePath)
                    )
                    if (!sameStatusLineDestination(selected, actual)) {
                      throw new Error('Claude settings destination changed')
                    }
                    invocation.check()
                  }
                })
              }
            } catch (error) {
              errors.push(String(error))
            }
          }
        } catch (error) {
          errors.push(String(error))
        }
        invocation.check()
        await rm(getStatusLineInstallMarkerPath(), { force: true }).catch((error: unknown) =>
          errors.push(String(error))
        )
        if (errors.length) {
          throw new Error(errors.join('; '))
        }
      },
      invocation.check
    )
  } finally {
    invocation.finish()
  }
}
