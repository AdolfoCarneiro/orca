import type {
  PtyFencedTerminationRequest,
  PtyFencedTerminationOutcome
} from '../../shared/pty-fenced-termination'
import type { Session } from './session'
import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'

type FencedTermination =
  | { accepted: false; result: PtyFencedTerminationOutcome }
  | { accepted: true; completion: Promise<PtyFencedTerminationOutcome> }

export function beginTerminalHostFencedTermination(
  request: PtyFencedTerminationRequest,
  deps: {
    sessions: ReadonlyMap<string, Session>
    pendingCreations: ReadonlyMap<string, unknown>
    owners: ClaimedAgentPtyOwnerRegistry
    kill: (
      id: string,
      options: { immediate: true; switchCheck?: () => boolean; ownedSpawn?: true }
    ) => Promise<void>
  }
): FencedTermination {
  const session = deps.sessions.get(request.id)
  if (!session || !session.isAlive) {
    return { accepted: false, result: { outcome: 'already_exited' } }
  }
  if (session.incarnationId !== request.expectedIncarnationId) {
    return { accepted: false, result: { outcome: 'refused', reason: 'replaced' } }
  }
  // Pending creates include claim reservation and promotion, before the owner is listed.
  if (deps.pendingCreations.has(request.id)) {
    return { accepted: false, result: { outcome: 'refused', reason: 'claimed' } }
  }
  if (request.requireNoAgentOwner && deps.owners.listForPty(request.id).length > 0) {
    return { accepted: false, result: { outcome: 'refused', reason: 'claimed' } }
  }
  // Current mains check viewers themselves; this guards older mains and direct callers.
  if (request.requireUnattached && session.hasAttachedClients) {
    return { accepted: false, result: { outcome: 'refused', reason: 'attached' } }
  }
  if (request.switchCondition && !request.switchCondition.ownedSpawn) {
    return { accepted: false, result: { outcome: 'refused', reason: 'unsupported' } }
  }
  const physicalCheck = request.switchCondition
    ? session.switchCloseCondition(request.switchCondition)
    : undefined
  const switchCheck = physicalCheck
    ? () =>
        deps.sessions.get(request.id) === session &&
        !deps.pendingCreations.has(request.id) &&
        (!request.requireNoAgentOwner || deps.owners.listForPty(request.id).length === 0) &&
        (!request.switchCondition?.ownedSpawn ||
          deps.owners
            .listForPty(request.id)
            .every((owner) => owner.generation === request.switchCondition?.claimGeneration)) &&
        physicalCheck()
    : undefined
  if (switchCheck && !switchCheck()) {
    return { accepted: false, result: { outcome: 'refused', reason: 'unverifiable' } }
  }
  try {
    // kill reserves the exact Session synchronously, before its first OS probe.
    const completion = deps
      .kill(request.id, {
        immediate: true,
        ...(switchCheck ? { switchCheck, ownedSpawn: request.switchCondition?.ownedSpawn } : {})
      })
      .then((): PtyFencedTerminationOutcome =>
        session.isAlive ? { outcome: 'refused', reason: 'unverifiable' } : { outcome: 'ended' }
      )
      .catch((): PtyFencedTerminationOutcome => ({ outcome: 'refused', reason: 'unverifiable' }))
    return { accepted: true, completion }
  } catch {
    return { accepted: false, result: { outcome: 'refused', reason: 'unverifiable' } }
  }
}
