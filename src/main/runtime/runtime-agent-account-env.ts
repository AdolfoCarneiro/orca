import type { TerminalCreateOptions } from './runtime-terminal-contracts'

/** Desktop-selected account env overrides the launch plan; explicit caller env/accountEnv still wins. */
export function withHostAccountLaunchEnv(
  requested: Pick<TerminalCreateOptions, 'env' | 'accountEnv'>,
  launch: TerminalCreateOptions,
  accountEnv: Readonly<Record<string, string>>
): TerminalCreateOptions {
  if (Object.keys(accountEnv).length === 0) {
    return launch
  }
  return {
    ...launch,
    env: {
      ...launch.env,
      ...accountEnv,
      ...requested.env,
      ...requested.accountEnv
    }
  }
}
