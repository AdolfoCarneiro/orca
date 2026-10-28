import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import type { TuiAgent } from '../../../shared/tui-agent'
import { createAgentSessionKeyboardOptions } from './agent-session-keyboard-capability'
import { agentProviderSessionForHostEnsure } from './agent-session-ensure-provider-session'
import {
  createAgentSessionCreateOperation,
  withAgentSessionCreateOperationId
} from './agent-session-create-operation'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { captureRuntimeEnvironmentCall } from './web-runtime-session-environment'
import type { CreateWebRuntimeSessionTerminalArgs } from './web-runtime-session-types'
import { readCreatedAgentTerminalIdentity } from './web-runtime-terminal-identity'

export function createWebRuntimeAgentTerminalHostAuthority(
  environmentId: string,
  args: CreateWebRuntimeSessionTerminalArgs,
  agent: TuiAgent,
  agentArgsOverride: string | null | undefined,
  callEnvironment: ReturnType<typeof captureRuntimeEnvironmentCall>
) {
  // Paired panes retain the default keyboard advertisement, including on Windows clients.
  const keyboardProtocol = buildDefaultTerminalOptions().vtExtensions?.kittyKeyboard
  const keyboardOptions = createAgentSessionKeyboardOptions(keyboardProtocol)
  // Why: structured creation cannot yet express afterTabId; keep the exact legacy placement contract until it can.
  // Why: focus belongs to the paired client; a headless execution host has no renderer to focus.
  // Why: rebuilding a prepared command through host authority can discard its embedded prompt and delivery flags.
  // A switch uses the ordinary prepared command and admission.
  const mustUseLegacyAgentCreate =
    args.preparedAgentCommand || args.afterTabId || args.resumeOrigin === 'switch'
  return mustUseLegacyAgentCreate
    ? undefined
    : args.agentSessionKind === 'resume'
      ? args.providerSession
        ? async () =>
            readCreatedAgentTerminalIdentity(
              unwrapRuntimeRpcResult(
                await callEnvironment({
                  method: 'terminal.ensureAgentSession',
                  params: {
                    ...(await keyboardOptions(environmentId)),
                    kind: 'explicit',
                    worktree: toRuntimeWorktreeSelector(args.worktreeId),
                    agent,
                    providerSession: await agentProviderSessionForHostEnsure(
                      environmentId,
                      args.providerSession!
                    ),
                    ...(args.launchConfig?.ompResumeFilePath
                      ? { ompResumeFilePath: args.launchConfig.ompResumeFilePath }
                      : {}),
                    ...(agentArgsOverride !== undefined ? { agentArgs: agentArgsOverride } : {}),
                    ...(args.launchPreferences
                      ? { launchPreferences: args.launchPreferences }
                      : {}),
                    presentation: 'background'
                  },
                  timeoutMs: 15_000
                })
              )
            )
        : undefined
      : async () =>
          await createAgentSessionCreateOperation().run(async (clientOperationId) =>
            readCreatedAgentTerminalIdentity(
              unwrapRuntimeRpcResult(
                await callEnvironment({
                  method: 'terminal.createAgentSession',
                  params: withAgentSessionCreateOperationId(
                    {
                      ...(await keyboardOptions(environmentId)),
                      worktree: toRuntimeWorktreeSelector(args.worktreeId),
                      agent,
                      ...(args.prompt ? { prompt: args.prompt } : {}),
                      ...(args.promptDelivery ? { promptDelivery: args.promptDelivery } : {}),
                      ...(agentArgsOverride !== undefined ? { agentArgs: agentArgsOverride } : {}),
                      ...(args.launchPreferences
                        ? { launchPreferences: args.launchPreferences }
                        : {}),
                      ...(args.cwd ? { startupCwd: args.cwd } : {}),
                      ...(args.viewMode ? { viewMode: args.viewMode } : {}),
                      presentation: 'background'
                    },
                    clientOperationId
                  ),
                  timeoutMs: 15_000
                })
              )
            )
          )
}
