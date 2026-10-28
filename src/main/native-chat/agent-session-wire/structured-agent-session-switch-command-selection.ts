import type { StructuredAgentSessionConversationLifetimeHost } from './structured-agent-session-conversation-lifetime-host'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import type {
  AgentSessionSwitchDeadline,
  AgentSessionSwitchResult
} from '../../../shared/agent-session-switch-execution'

export type SwitchCommand = {
  invocationId: string
  generation: string
  direction: 'chat' | 'terminal'
  workCurrent?: () => boolean
  settled: boolean
  result?: AgentSessionSwitchResult
  deadline: AgentSessionSwitchDeadline
  retain: () => Promise<void>
  retentionAllowed: boolean
  completion: Promise<AgentSessionSwitchResult>
  physical?: Promise<void>
  physicalRecovery?: Set<() => Promise<void>>
  cleanupTimer?: ReturnType<typeof setTimeout>
}

/** The command owns dispatched work even after its viewer gives up. */
export function selectStructuredSessionSwitchCommand(args: {
  host: StructuredAgentSessionConversationLifetimeHost
  commands: Map<string, SwitchCommand>
  isDisposed: () => boolean
  id: string
  invocationId: string
  direction: SwitchCommand['direction']
  deadline: AgentSessionSwitchDeadline
  run: () => Promise<AgentSessionSwitchResult>
  onRetained?: (check: () => void) => Promise<void>
  allowUncreated?: boolean
  conversationKey?: string
}): SwitchCommand {
  const { host, commands, isDisposed, id, invocationId, direction, deadline, run, onRetained } =
    args
  const { sessions, serialize } = host
  deadline.check()
  const prior =
    (args.conversationKey ? commands.get(args.conversationKey) : undefined) ?? commands.get(id)
  if (prior) {
    if (
      prior.invocationId === invocationId ||
      (prior.direction === direction &&
        (!prior.settled ||
          (prior.result?.status === 'completed' &&
            prior.deadline.remaining() > 0 &&
            !prior.deadline.signal.aborted &&
            (!prior.workCurrent || prior.workCurrent()))))
    ) {
      commands.set(id, prior)
      if (args.conversationKey) {
        commands.set(args.conversationKey, prior)
      }
      return prior
    }
    if (!prior.settled) {
      throw agentSessionRefusalError('agent_session_operation_invalid', {
        reason: 'handoffInFlight'
      })
    }
    prior.retentionAllowed = false
    clearTimeout(prior.cleanupTimer)
    prior.deadline.revoke()
    for (const [alias, current] of commands) {
      if (current === prior) {
        commands.delete(alias)
      }
    }
  }
  if (!host.context().deps.store.getRecord(id) && !args.allowUncreated) {
    throw new AgentSessionRefusalError(AGENT_SESSION_NOT_ATTACHED)
  }
  const command: SwitchCommand = {
    invocationId,
    generation: invocationId,
    direction,
    settled: false,
    deadline,
    retentionAllowed: true,
    retain: async () => {
      const check = () => {
        if (!command.retentionAllowed || commands.get(id) !== command) {
          throw agentSessionRefusalError('agent_session_operation_expired', {
            reason: 'operationExpired'
          })
        }
      }
      check()
      await onRetained?.(check)
    },
    completion: Promise.resolve().then(async () => {
      if (host.context().deps.store.getRecord(id)) {
        await serialize(id, async () => {
          deadline.check()
          const session = await host.open(id)
          deadline.check()
          if (session) {
            session.switchCommand = command
          }
        })
      }
      try {
        const result = await run()
        command.result = result
        if (result.status !== 'completed') {
          await command.retain()
        }
        return result
      } catch (error) {
        await command.retain().catch(() => {})
        throw error
      }
    })
  }
  commands.set(id, command)
  if (args.conversationKey) {
    commands.set(args.conversationKey, command)
  }
  const retainOnExpiry = () => {
    void command.retain().catch(() => {})
  }
  deadline.signal.addEventListener('abort', retainOnExpiry, { once: true })
  const session = sessions.get(id)
  if (session) {
    session.switchCommand = command
  }
  host.context().publishStatus?.(id)
  void command.completion
    .finally(async () => {
      await command.physical
      command.settled = true
      deadline.dispose()
      deadline.signal.removeEventListener('abort', retainOnExpiry)
      for (const [key, current] of commands) {
        if (current === command && sessions.get(key)?.switchCommand === command) {
          delete sessions.get(key)!.switchCommand
        }
      }
      host.context().publishStatus?.(id)
      if (isDisposed()) {
        return
      }
      command.cleanupTimer = setTimeout(
        () => {
          command.retentionAllowed = false
          for (const [key, current] of commands) {
            if (current === command) {
              commands.delete(key)
            }
          }
        },
        Math.max(1, deadline.remaining())
      )
      command.cleanupTimer.unref?.()
    })
    .catch(() => {})
  return command
}
