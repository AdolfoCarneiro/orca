import type { StructuredAgentSessionConversationLifetimeHost } from './structured-agent-session-conversation-lifetime-host'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionSwitchDeadline,
  AgentSessionSwitchResult
} from '../../../shared/agent-session-switch-execution'
import {
  selectStructuredSessionSwitchCommand,
  type SwitchCommand
} from './structured-agent-session-switch-command-selection'

export function createStructuredAgentSessionSwitchCommands(
  host: StructuredAgentSessionConversationLifetimeHost,
  isDisposed: () => boolean
) {
  const commands = new Map<string, SwitchCommand>()
  const unsubscribe = host.context().deps.store.onAcceptedSend((id) => {
    const command = commands.get(id)
    if (command?.workCurrent && !command.settled && !command.workCurrent()) {
      command.deadline.revoke(
        agentSessionRefusalError('agent_session_operation_invalid', { reason: 'messagesUnsettled' })
      )
    }
  })
  return {
    controls: {
      runSwitch: async (
        id: string,
        invocationId: string,
        deadline: AgentSessionSwitchDeadline,
        run: () => Promise<AgentSessionSwitchResult>,
        options: {
          conversationKey?: string
          direction: SwitchCommand['direction']
          onRetained?: (check: () => void) => Promise<void>
          allowUncreated?: boolean
        }
      ): Promise<AgentSessionSwitchResult> => {
        const selected = await deadline.wait(
          host.serialize(options.conversationKey ?? id, async () =>
            selectStructuredSessionSwitchCommand({
              host,
              commands,
              isDisposed,
              id,
              invocationId,
              deadline,
              run,
              ...options
            })
          )
        )
        if (selected.deadline !== deadline) {
          deadline.dispose()
        }
        try {
          return await selected.completion
        } catch (error) {
          // Each ordinary retry drives the original receiver join, never another Stop/create.
          void Promise.all(
            [...(selected.physicalRecovery ?? [])].map((recover) => recover())
          ).catch(() => {})
          throw error
        }
      },
      adoptSwitch: (from: string, to: string) =>
        host.serialize(to, async () => {
          const command = commands.get(from)
          const prior = commands.get(to)
          command?.deadline.check()
          if (!command || (prior && prior !== command && !prior.settled)) {
            throw agentSessionRefusalError('agent_session_operation_invalid', {
              reason: 'handoffInFlight'
            })
          }
          commands.set(to, command)
        }),
      guardSwitchWork: (id: string, current: () => boolean) => {
        const command = commands.get(id)
        if (command) {
          command.workCurrent = current
        }
      },
      switchGeneration: (id: string) => commands.get(id)?.generation,
      retainSwitch: async (id: string) => {
        await commands.get(id)?.retain()
      },
      switchExecuting: (id: string) => Boolean(commands.get(id) && !commands.get(id)?.settled),
      trackSwitchPhysical: <T>(
        id: string,
        work: Promise<T>,
        recover?: () => Promise<void>
      ): Promise<T> => {
        const command = commands.get(id)
        if (command) {
          command.physical = Promise.allSettled([command.physical, work]).then(() => {})
          if (recover) {
            const recoveries = (command.physicalRecovery ??= new Set())
            recoveries.add(recover)
            void work.finally(() => recoveries.delete(recover)).catch(() => {})
          }
        }
        return work
      },
      waitSwitchPhysical: async (id: string): Promise<void> => {
        const command = commands.get(id)
        await Promise.all([...(command?.physicalRecovery ?? [])].map((recover) => recover()))
        await command?.physical
      }
    },
    revoke: (id: string) => {
      const command = commands.get(id)
      if (command) {
        command.retentionAllowed = false
        command.deadline.revoke()
      }
    },
    dispose: () => {
      unsubscribe()
      for (const command of commands.values()) {
        command.retentionAllowed = false
        clearTimeout(command.cleanupTimer)
        command.deadline.revoke()
      }
      commands.clear()
    }
  }
}
