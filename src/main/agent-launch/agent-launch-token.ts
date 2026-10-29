import { createHash } from 'node:crypto'

/** Bind configured launches to their environment and PTY with the same token. */
export function agentLaunchTokenFor(
  launch: { launchConfig?: unknown; launchToken?: string },
  mint: () => string
): string | undefined {
  return launch.launchConfig ? (launch.launchToken ?? mint()) : undefined
}

export function withAgentLaunchToken(
  env: Record<string, string> | undefined,
  launchToken: string | undefined
): Record<string, string> {
  return { ...env, ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {}) }
}

/** The commitment a Dispatch persists for its terminal's launch. */
export function agentLaunchTokenHash(launchToken: string): string {
  return createHash('sha256').update(launchToken).digest('hex')
}

/** Derived from the persisted commitment so a restarted runtime can still expect it; the token itself never prints. */
export function launchExitReceiptId(launchTokenHash: string): string {
  return createHash('sha256').update(`launch-exit:${launchTokenHash}`).digest('hex').slice(0, 32)
}
