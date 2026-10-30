import { mobileAgentSessionWriteNoticeText } from './agent-session-write-notice-copy'
import { translate } from '../i18n/mobile-i18n'

export function mobileSenderOpenFailure(
  outcome: 'chat' | 'terminal' | 'unreachable' | 'unsupported'
): string {
  return outcome === 'chat'
    ? translate(
        'chat.agentMessage.gone',
        'This chat is no longer on this host, so it cannot be reopened here.'
      )
    : outcome === 'terminal'
      ? translate('chat.agentMessage.paneUnavailable', "Agent's pane is no longer available.")
      : mobileAgentSessionWriteNoticeText(
          outcome === 'unsupported' ? ['unsupported'] : ['unreachable', 'tryAgain']
        )
}
