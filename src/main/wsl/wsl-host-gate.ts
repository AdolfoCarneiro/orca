import {
  formatWslHostsPolicyBlockedArgument,
  formatWslHostsServeOnlyArgument,
  isWslHostsInternalGateOpen,
  noteWslHostsPolicyBlocked,
  noteWslHostsServeOnly,
  resolveWslHostsGateState,
  type WslHostsGateState
} from '../../shared/wsl-host-internal-gate'
import type { OrcadDeploymentLink } from '../../shared/runtime-environments'

export const WSL_HOSTS_GATED_OFF_MESSAGE = 'WSL hosts are not available in this build.'
export const WSL_HOSTS_NEW_WORK_PAUSED_MESSAGE =
  'Adding WSL hosts and moving projects onto them is paused in this build. Your saved WSL hosts keep working.'

// Fixed for the run once main reads the disk; nothing can create a host or a move while not open.
let promoted: { hasSavedWslHost: boolean; hasWslMoveCutover: boolean } | null = null
// Also fixed for the run: a mid-run flip could pull a live host or an in-flight move from under the user.
let policyBlocked = false

// Unreadable state counts as absent: today's closed behavior, and an unreadable policy blocks nothing.
function readFact(fact: () => boolean): boolean {
  try {
    return fact()
  } catch {
    return false
  }
}

function notePolicyBlocked(blocked: boolean): void {
  policyBlocked = blocked
  noteWslHostsPolicyBlocked(blocked)
}

/**
 * Startup, before any gate check. A cached remote policy block closes an open internal gate, and a
 * closed gate with saved WSL work becomes `serve-only`, so blocking never strands a moved project.
 */
export function configureWslHostsGate(facts: {
  hasSavedWslHost: () => boolean
  hasWslMoveCutover: () => boolean
  policyBlocks?: () => boolean
}): void {
  const { policyBlocks } = facts
  notePolicyBlocked(
    isWslHostsInternalGateOpen(process.env) && policyBlocks !== undefined && readFact(policyBlocks)
  )
  if (wslHostsGateOpen()) {
    promoted = null
    noteWslHostsServeOnly(false)
    return
  }
  promoted = {
    hasSavedWslHost: readFact(facts.hasSavedWslHost),
    hasWslMoveCutover: readFact(facts.hasWslMoveCutover)
  }
  noteWslHostsServeOnly(wslHostsGateState() === 'serve-only')
}

export function resetWslHostsGateForTests(): void {
  promoted = null
  noteWslHostsServeOnly(false)
  notePolicyBlocked(false)
}

export function wslHostsGateState(): WslHostsGateState {
  return resolveWslHostsGateState({
    gateOpen: wslHostsGateOpen(),
    hasSavedWslHost: promoted?.hasSavedWslHost ?? false,
    hasWslMoveCutover: promoted?.hasWslMoveCutover ?? false
  })
}

/** Argv for any window on the shared preload, which cannot read the disk to learn serve-only. */
export function wslHostsWindowArguments(): string[] {
  return [
    ...(policyBlocked ? [formatWslHostsPolicyBlockedArgument()] : []),
    ...(wslHostsGateState() === 'serve-only' ? [formatWslHostsServeOnlyArgument()] : [])
  ]
}

/** The internal gate itself, less a remote policy block: adding hosts and starting moves need it. */
export function wslHostsGateOpen(): boolean {
  return isWslHostsInternalGateOpen(process.env) && !policyBlocked
}

/** The launch environment opened the gate, but the cached remote policy closed it for this run. */
export function wslHostsPolicyBlocked(): boolean {
  return policyBlocked
}

/** Saved hosts and moved projects stay reachable: `open` or `serve-only`. */
export function wslHostsServing(): boolean {
  return wslHostsGateState() !== 'closed'
}

/** A persisted WSL host while the gate is closed: left on disk, but never listed or reached. */
export function isGatedOffWslHost(environment: {
  orcadDeployment?: OrcadDeploymentLink | null
}): boolean {
  return environment.orcadDeployment?.kind === 'wsl' && !wslHostsServing()
}

export function assertWslHostReachable(environment: {
  orcadDeployment?: OrcadDeploymentLink | null
}): void {
  if (isGatedOffWslHost(environment)) {
    throw new Error(WSL_HOSTS_GATED_OFF_MESSAGE)
  }
}
