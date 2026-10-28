import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { StructuredAgentSessionStatusFeedOwner } from './structured-agent-session-status-feed'

export type OwnedStatusFeed = StructuredAgentSessionStatusFeedOwner & {
  stop: () => void
  isUnused: () => boolean
}

const owners = new Map<string, OwnedStatusFeed>()

export function structuredAgentSessionStatusFeedKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

export function getOrCreateStructuredAgentSessionStatusFeed(
  target: RuntimeClientTarget,
  createOwner: (target: RuntimeClientTarget) => OwnedStatusFeed
): StructuredAgentSessionStatusFeedOwner {
  const key = structuredAgentSessionStatusFeedKey(target)
  let owner = owners.get(key)
  if (!owner) {
    owner = createOwner(target)
    owners.set(key, owner)
  }
  return owner
}

export function retireStructuredAgentSessionStatusFeeds(environmentIds: readonly string[]): void {
  for (const environmentId of environmentIds) {
    const key = structuredAgentSessionStatusFeedKey({ kind: 'environment', environmentId })
    const owner = owners.get(key)
    if (owner?.isUnused()) {
      owner.stop()
      if (owners.get(key) === owner) {
        owners.delete(key)
      }
    }
  }
}

export function resetStructuredAgentSessionStatusFeedsForTests(): void {
  // Stop before deleting so synchronous listeners cannot create an untracked replacement.
  for (const owner of owners.values()) {
    owner.stop()
  }
  owners.clear()
}
