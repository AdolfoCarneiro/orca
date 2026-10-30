import { withTimeout } from '../../shared/promise-timeout-fallback'
import {
  CODEX_HOOK_LAUNCH_WAIT_MS,
  readKnownCodexHookAnswer,
  resolveCodexHookAnswer,
  startCodexHookHashLookup
} from './codex-hook-hash-lookup'
import type { CodexHookAnswer } from './codex-hook-trust-derivation'
import { reconcileRealHomeCodexHookEntries } from './codex-real-home-hook-install'

type ReconcileConfig = {
  isEnabled: () => boolean
  reconcileRetainedHomes?: (isCurrent: () => boolean) => Promise<boolean>
  /** Next native pane's CODEX_HOME; null for ~/.codex, throws while unknown. */
  resolveLaunchHome: () => string | null
}

type ReconcileRequest = {
  retainedHomes?: boolean
  /** Only app start or explicit enablement may replace older builds' entries. */
  convertOlderForms?: boolean
  /** Force ~/.codex for launches such as resumes that bypass the selected home. */
  realHomeLaunch?: boolean
}

// CLI processes leave reconciliation to app main.
let config: (ReconcileConfig & { pathReady: Promise<unknown> }) | null = null
let running: Promise<void> | null = null
let rerun = false
let retainedRequested = false
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = 100
// Retain conversion requests while hooks are off or another home is selected.
let convertRequested = false
// Consume launch requests on the next run; their launch proceeds even if reconciliation cannot.
let realHomeLaunchRequested = false

// Leave room in the launch's 3s budget to write stopgap approvals.
const ANSWER_WAIT_MS = 500

/** Start app-main hash lookup and reconciliation after shell PATH hydration. */
export function startCodexHooks({
  pathReady: hydrating,
  ...appConfig
}: ReconcileConfig & { pathReady: Promise<unknown> }): void {
  stopCodexHooks()
  const pathReady = hydrating.catch(() => {})
  startCodexHookHashLookup(pathReady)
  const current = { ...appConfig, pathReady }
  config = current
  void pathReady.then(() =>
    config === current && current.isEnabled() ? resolveCodexHookAnswer() : undefined
  )
  void reconcileCodexHooks({ convertOlderForms: true })
}

/** Concurrent requests join the same owner; replacement retains its own hydration. */
export function reconcileCodexHooks(request: ReconcileRequest = {}): Promise<void> {
  if (!config) {
    return Promise.resolve()
  }
  retainedRequested ||= request.retainedHomes ?? !request.realHomeLaunch
  convertRequested ||= request.convertOlderForms === true
  realHomeLaunchRequested ||= request.realHomeLaunch === true
  if (running) {
    rerun = true
    return running
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
  }
  retryTimer = null
  running = Promise.resolve().then(runUntilSettled)
  return running
}

export function scheduleCodexHookReconcile(retainedHomes = false): void {
  // One run already reads after the spawn; coalesce calls from its multiple env builders.
  if (config && !retryTimer && (!running || retainedHomes)) {
    void reconcileCodexHooks({ retainedHomes })
  }
}

/** Bound reconciliation waits so real-home launches can proceed. */
export function reconcileCodexHooksForLaunch(): Promise<void> {
  return withTimeout(
    reconcileCodexHooks({ realHomeLaunch: true }),
    CODEX_HOOK_LAUNCH_WAIT_MS,
    undefined
  )
}

/** Status follows the next native pane's home; CLI processes default to ~/.codex. */
export function resolveCodexHookStatusHome(): CodexHookHomeChoice {
  return resolveHome(config)
}

type CodexHookHomeChoice =
  | { kind: 'real' }
  | { kind: 'managed'; path: string }
  | { kind: 'unknown' }

// Status and reconciliation must agree on the active home.
function resolveHome(current: ReconcileConfig | null): CodexHookHomeChoice {
  if (!current) {
    return { kind: 'real' }
  }
  try {
    const path = current.resolveLaunchHome()
    return path === null ? { kind: 'real' } : { kind: 'managed', path }
  } catch {
    return { kind: 'unknown' }
  }
}

async function runUntilSettled(): Promise<void> {
  for (;;) {
    rerun = false
    const current = config
    const maintainRetained = retainedRequested
    const realHomeLaunch = realHomeLaunchRequested
    const convertOlderForms = convertRequested
    retainedRequested = realHomeLaunchRequested = convertRequested = false
    let main: 'settled' | 'unavailable' | 'deferred' = 'settled'
    let retained = true
    if (current) {
      await current.pathReady
      if (config === current) {
        try {
          main = await reconcileOnce(current, realHomeLaunch, convertOlderForms)
        } catch (error) {
          main = 'unavailable'
          console.warn('[codex-hook-reconcile] Codex hook reconcile failed:', error)
        }
        // Main failure cannot starve independently authorized retained targets.
        if (maintainRetained && config === current) {
          try {
            retained = (await current.reconcileRetainedHomes?.(() => config === current)) !== false
          } catch (error) {
            retained = false
            console.warn('[codex-hook-reconcile] Retained Codex hook reconcile failed:', error)
          }
        }
        if (config === current) {
          if (main !== 'settled') {
            convertRequested ||= convertOlderForms
          }
          if (main === 'unavailable') {
            realHomeLaunchRequested ||= realHomeLaunch
          }
          if (!retained) {
            retainedRequested = true
          }
          if (main === 'unavailable' || !retained) {
            scheduleRetry(current)
          } else {
            if (retryTimer) {
              clearTimeout(retryTimer)
            }
            retryTimer = null
            retryDelay = 100
          }
        }
      }
    }
    if (!rerun) {
      running = null
      return
    }
  }
}

function scheduleRetry(current: NonNullable<typeof config>): void {
  if (config !== current || retryTimer) {
    return
  }
  retryTimer = setTimeout(() => {
    if (config !== current) {
      return
    }
    retryTimer = null
    void reconcileCodexHooks({ retainedHomes: false })
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, 30_000)
  retryTimer.unref?.()
}

async function reconcileOnce(
  current: ReconcileConfig,
  realHomeLaunch: boolean,
  convertOlderForms: boolean
): Promise<'settled' | 'unavailable' | 'deferred'> {
  if (config !== current) {
    return 'settled'
  }
  if (!current.isEnabled()) {
    return 'deferred'
  }
  const home = resolveHome(current)
  if (!realHomeLaunch && home.kind !== 'real') {
    return home.kind === 'unknown' ? 'unavailable' : 'deferred'
  }
  const lookup = resolveCodexHookAnswer()
  const live = await withTimeout<CodexHookAnswer | null>(lookup, ANSWER_WAIT_MS, null)
  if (config !== current) {
    return 'settled'
  }
  if (!live) {
    void lookup.then(() => {
      if (config === current) {
        void reconcileCodexHooks({ realHomeLaunch, retainedHomes: true })
      }
    })
  }
  const answer = live && live.kind !== 'pending' ? live : readKnownCodexHookAnswer()
  if (answer?.kind === 'refused' || (answer?.kind === 'pending' && answer.codexMissing)) {
    return 'settled'
  }
  return reconcileRealHomeCodexHookEntries({
    hashes: answer?.kind === 'hashes' ? answer.hashes : null,
    isEnabled: () =>
      config === current &&
      current.isEnabled() &&
      (realHomeLaunch || resolveHome(current).kind === 'real'),
    convertOlderForms
  })
}

export function stopCodexHooks(): void {
  config = null
  rerun = false
  retainedRequested = convertRequested = realHomeLaunchRequested = false
  retryDelay = 100
  if (retryTimer) {
    clearTimeout(retryTimer)
  }
  retryTimer = null
}

export const _internals = {
  resetForTesting(): void {
    if (retryTimer) {
      clearTimeout(retryTimer)
    }
    retryTimer = null
    retryDelay = 100
    config = null
    running = null
    rerun = false
    retainedRequested = false
    convertRequested = false
    realHomeLaunchRequested = false
  },
  async settledForTesting(): Promise<void> {
    while (running) {
      await running
    }
  }
}
