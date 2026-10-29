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
let config: ReconcileConfig | null = null
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
  if (retryTimer) {
    clearTimeout(retryTimer)
  }
  retryTimer = null
  const pathReady = hydrating.catch(() => {})
  startCodexHookHashLookup(pathReady)
  config = appConfig
  // Warm the hash cache before the first managed launch.
  void pathReady.then(() => (appConfig.isEnabled() ? resolveCodexHookAnswer() : undefined))
  // Early launches must join this run and wait for PATH hydration.
  void reconcileAfter(pathReady, { convertOlderForms: true })
}

/** Concurrent calls request another pass; reconciliation failures are logged. */
export function reconcileCodexHooks(request: ReconcileRequest = {}): Promise<void> {
  return reconcileAfter(Promise.resolve(), request)
}

function reconcileAfter(ready: Promise<unknown>, request: ReconcileRequest): Promise<void> {
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
  running = ready.then(runUntilSettled)
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
    const maintainRetained = retainedRequested
    retainedRequested = false
    const realHomeLaunch = realHomeLaunchRequested
    realHomeLaunchRequested = false
    try {
      const current = config
      await reconcileOnce(realHomeLaunch)
      if (maintainRetained && current && config === current) {
        if ((await current.reconcileRetainedHomes?.(() => config === current)) === false) {
          scheduleRetry()
        } else {
          retryDelay = 100
        }
      }
    } catch (error) {
      console.warn('[codex-hook-reconcile] Codex hook reconcile failed:', error)
      scheduleRetry()
    }
    // Clear running without yielding so new requests cannot join a finished run.
    if (!rerun) {
      running = null
      return
    }
  }
}

function scheduleRetry(): void {
  if (!config || retryTimer) {
    return
  }
  retryTimer = setTimeout(() => {
    retryTimer = null
    void reconcileCodexHooks({ retainedHomes: true })
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, 30_000)
  retryTimer.unref?.()
}

async function reconcileOnce(realHomeLaunch: boolean): Promise<void> {
  const current = config
  if (!current?.isEnabled() || !(realHomeLaunch || resolveHome(current).kind === 'real')) {
    return
  }
  const lookup = resolveCodexHookAnswer()
  const live = await withTimeout<CodexHookAnswer | null>(lookup, ANSWER_WAIT_MS, null)
  if (!live) {
    // Replace stopgap approvals once Codex's answer arrives.
    void lookup.then(() => reconcileCodexHooks({ realHomeLaunch, retainedHomes: true }))
  }
  // Reuse Codex's saved answer so a slow startup probe does not disturb existing hooks.
  const answer = live && live.kind !== 'pending' ? live : readKnownCodexHookAnswer()
  if (answer?.kind === 'refused' || (answer?.kind === 'pending' && answer.codexMissing)) {
    return
  }
  const convertOlderForms = convertRequested
  convertRequested = false
  await reconcileRealHomeCodexHookEntries({
    hashes: answer?.kind === 'hashes' ? answer.hashes : null,
    isEnabled: () => config === current && current.isEnabled(),
    convertOlderForms
  })
}

export function stopCodexHooks(): void {
  config = null
  rerun = false
  retainedRequested = false
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
