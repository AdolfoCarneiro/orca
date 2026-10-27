import type { AiVaultPrepareSessionResumeResult } from '../../../shared/ai-vault-resume-preparation'
import {
  buildAiVaultDropRepinStartup,
  buildAiVaultResumeForWorktree,
  buildAiVaultResumeStartupForWorktree,
  type AiVaultResumeWorktreeArgs,
  type AiVaultResumeStartup
} from './ai-vault-resume-command'
import type { AiVaultSessionDragPayload } from './ai-vault-session-drag'
import { resolveTerminalHostOwnership } from './terminal-worktree-route'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'

export type AiVaultResumeDragStartup = AiVaultResumeStartup & {
  localFallback?: AiVaultResumeStartup
}
export type AiVaultLocalDragPayload = Omit<AiVaultSessionDragPayload, 'realHomeStartup'> &
  AiVaultResumeDragStartup & { realHomeStartup?: AiVaultResumeDragStartup }

export function buildAiVaultResumeDragStartupForWorktree(
  args: AiVaultResumeWorktreeArgs
): AiVaultResumeDragStartup {
  if (args.session.executionHostId && args.session.executionHostId !== 'local') {
    return buildAiVaultResumeForWorktree(args, false)
  }
  const selected = buildAiVaultResumeStartupForWorktree(args)
  if (!selected.resume) {
    return selected
  }
  const { resume, command, env, envToDelete, launchConfig, providerSession } = selected
  return {
    ...buildAiVaultResumeForWorktree(args, false),
    resume,
    localFallback: {
      command,
      ...(env ? { env } : {}),
      ...(envToDelete ? { envToDelete } : {}),
      ...(launchConfig ? { launchConfig } : {}),
      ...(providerSession ? { providerSession } : {})
    }
  }
}

export function isLocalAiVaultDragTarget(
  state: AiVaultResumeWorktreeArgs['state'],
  worktreeId: string,
  sourceHostId: string | undefined
): boolean {
  return (
    sourceHostId === 'local' &&
    getExecutionHostIdForWorktree(state, worktreeId) === 'local' &&
    resolveTerminalHostOwnership(state, worktreeId, 'spawn').kind === 'local-or-ssh'
  )
}

export function preparedAiVaultDragStartup<T extends AiVaultResumeDragStartup>(startup: T) {
  const { resume: _resume, localFallback: _fallback, ...prepared } = startup
  return prepared
}

export function prepareAiVaultDroppedStartup(
  state: AiVaultResumeWorktreeArgs['state'],
  worktreeId: string,
  payload: AiVaultSessionDragPayload,
  result: AiVaultPrepareSessionResumeResult,
  local?: { normal: AiVaultResumeDragStartup; realHome?: AiVaultResumeDragStartup } | null
): AiVaultResumeStartup | null {
  if (!result.useRealCodexHome && result.substituteCodexHome) {
    return buildAiVaultDropRepinStartup({
      state,
      worktreeId,
      payload,
      substituteCodexHome: result.substituteCodexHome
    })
  }
  const selected = isLocalAiVaultDragTarget(state, worktreeId, payload.sessionExecutionHostId)
    ? local
    : null
  const startup = result.useRealCodexHome
    ? (selected?.realHome ?? payload.realHomeStartup)
    : (selected?.normal ?? payload)
  return startup ?? null
}
