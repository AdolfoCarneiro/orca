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

/** Names a launch in its exit receipt without printing the token itself into the terminal. */
export function launchExitReceiptId(launchToken: string): string {
  return createHash('sha256').update(`launch-exit:${launchToken}`).digest('hex').slice(0, 32)
}
