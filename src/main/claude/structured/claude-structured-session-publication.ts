import { agentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { CLAUDE_STRUCTURED_AGENT } from '../claude-structured-agent-definition'
import { refreshClaudeStructuredSessionOptions } from '../claude-structured-session-options'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput
} from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { claudeProviderHandleLink } from './claude-structured-owner-identity'
import type { ClaudePromptRegistry } from '../claude-prompt-registry'
import type { ClaudeJournalTranslator } from '../claude-journal-translator-contract'
import type {
  ClaudeSession,
  ClaudeAcquisitionAttempt,
  ClaudeAcquireCallbacks
} from './claude-structured-session-state'
import { ClaudeBackgroundTaskTracker } from '../claude-background-task-tracker'
import { ClaudeChildWorkDecoder } from '../claude-child-work-decoder'
import { ClaudeSlashCommandCatalog } from '../claude-slash-command-catalog'
import type { ClaudeStructuredLaunch } from '../claude-structured-launch-resolution'

/** Pin successful launch inputs before publishing the host's fenced acquisition. */
export function claudeSessionInitialization(
  launch: Pick<
    ClaudeStructuredLaunch,
    'account' | 'accountRecipe' | 'resumesTranscript' | 'claudeConfigDir' | 'cwd' | 'resumeLeafUuid'
  >,
  proof: ClaudeSession['initialization']['proof'],
  contextActivity: number,
  onLateRefusal: (error: Error) => void
): ClaudeSession['initialization'] {
  return {
    proof,
    account: launch.account,
    ...(launch.accountRecipe ? { accountRecipe: launch.accountRecipe } : {}),
    resumesTranscript: launch.resumesTranscript,
    claudeConfigDir: launch.claudeConfigDir,
    cwd: launch.cwd,
    history: {
      leafUuid: launch.resumeLeafUuid,
      covered: !launch.resumesTranscript || launch.resumeLeafUuid === null,
      contextActivity
    },
    onLateRefusal
  }
}

export function createClaudeSessionPublication(input: {
  connection: ClaudeSession['connection']
  providerSessionId: string
  leafUuid: string | null
  /** A frame seen before publication does not prove a completed turn. */
  turnEndLeafUuid: string | null
  fence: number
  acquisitionGeneration: string
  continuesChain: boolean
  forkedFromKey?: string
  prompts: ClaudePromptRegistry
  translator: ClaudeJournalTranslator | null
  events: ClaudeSession['events']
  unbindReadingControl?: () => void
  process: AgentSessionAcquisition['process']
  linkId?: string
  observedAt: number
  options?: ReadonlyMap<string, string>
  initialization: ClaudeSession['initialization']
}): { acquisition: AgentSessionAcquisition; session: ClaudeSession } {
  const link = claudeProviderHandleLink({
    sessionId: input.providerSessionId,
    leafUuid: input.leafUuid,
    resumed: input.continuesChain,
    ...(input.forkedFromKey ? { forkedFromKey: input.forkedFromKey } : {}),
    fence: input.fence,
    ...(input.linkId ? { linkId: input.linkId } : {}),
    observedAt: input.observedAt
  })
  return {
    acquisition: {
      process: input.process,
      ...(input.initialization.accountRecipe
        ? { accountRecipe: input.initialization.accountRecipe }
        : {}),
      acquisitionGeneration: input.acquisitionGeneration,
      accountHome: agentSessionAccountHome(
        CLAUDE_STRUCTURED_AGENT,
        input.initialization.claudeConfigDir
      )
    },
    session: {
      connection: input.connection,
      providerSessionId: input.providerSessionId,
      leafUuid: input.leafUuid,
      turnEndLeafUuid: input.turnEndLeafUuid,
      fence: input.fence,
      acquisitionGeneration: input.acquisitionGeneration,
      prompts: input.prompts,
      dispatchWaiters: [],
      retiredDispatchWaiters: [],
      replayContentFallbackBlocked: false,
      backgroundTasks: new ClaudeBackgroundTaskTracker(),
      childWork: new ClaudeChildWorkDecoder(),
      // An unread catalog is unavailable, not empty.
      commands: new ClaudeSlashCommandCatalog(),
      dispatchSequence: 0,
      optionMutationSequence: 0,
      options: new Map(input.options),
      capabilities: [],
      reportedOptions: {},
      reportedModelMutation: 0,
      confirmedOptions: new Set(),
      // Only options included at launch can skip their first control write.
      appliedInputOptions: new Map(
        [...(input.options ?? [])].filter(([key]) => key === 'model' || key === 'effort')
      ),
      fastModeAtStart: false,
      translator: input.translator,
      events: input.events,
      ...(input.unbindReadingControl ? { unbindReadingControl: input.unbindReadingControl } : {}),
      link,
      initialization: input.initialization
    }
  }
}

/** Optional reporting keeps the same acquisition and connection as native result publication. */
export function reportClaudeOptions(
  session: ClaudeSession,
  sessions: Map<string, ClaudeSession>,
  input: StructuredAgentSessionAcquireInput,
  timeoutMs: number | undefined,
  attempt: ClaudeAcquisitionAttempt,
  callbacks: ClaudeAcquireCallbacks
): void {
  const sessionId = input.identity.sessionId
  void refreshClaudeStructuredSessionOptions(
    session,
    timeoutMs,
    () => sessions.get(sessionId) === session,
    (options) =>
      callbacks.deliver(attempt, sessionId, () =>
        callbacks.emit(session, input.events, {
          type: 'options-reported',
          sessionId,
          fence: session.fence,
          acquisitionGeneration: session.acquisitionGeneration,
          reportedOptions: options.current
        })
      )
  ).catch(() => {})
}
