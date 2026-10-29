import { resolveAgentTerminalCreateOptions } from '../../../main/runtime/runtime-agent-terminal-startup'
import { partialRuntimeStore } from '../../../main/runtime/runtime-store-partial-fixture'
import type { AiVaultResumeStartup, AiVaultResumeWorktreeArgs } from './ai-vault-resume-command'

export async function materializeAiVaultResumeForTest(
  args: AiVaultResumeWorktreeArgs,
  startup: AiVaultResumeStartup
): Promise<AiVaultResumeStartup> {
  if (!startup.resume) {
    return startup
  }
  const planned = await resolveAgentTerminalCreateOptions(
    { id: 'wt', path: '/repo', repo: null, folderWorkspace: null, connectionId: null },
    {
      resume: startup.resume,
      cwd: startup.cwd,
      env: startup.env,
      envToDelete: startup.envToDelete,
      startupAgent: args.session.agent,
      resumeProviderSession: startup.providerSession,
      launchRuntime: { platform: 'linux', pty: {} }
    },
    {
      store: partialRuntimeStore({ getSettings: () => args.state.settings ?? {} }),
      hostIdentity: 'local',
      toSessionOptions: () => undefined
    }
  )
  return {
    ...startup,
    command: planned.command ?? '',
    env: planned.env,
    launchConfig: planned.launchConfig,
    providerSession: planned.resumeProviderSession
  }
}
