import { memo, useContext, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ArrowUpRight, Bot } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import type { AgentMessageSource } from '../../../../../src/shared/agent-session/agent-session-message-source'
import { agentMessageSendersShown } from '../../../../../src/shared/agent-session/agent-session-message-source'
import {
  AGENT_MESSAGE_FOLDED_LINES,
  agentMessageHeading,
  agentMessagePrimarySender,
  agentMessageSenderLabel,
  agentMessageSenderCanOpen,
  agentMessageOverflows,
  agentMessageFoldLabel,
  agentMessageCanCopy,
  agentMessageSenderView
} from '../../../../../src/shared/agent-session/agent-message-presentation'
import { agentMessageTranscriptText } from '../../../../../src/shared/agent-session/agent-message-display-text'
import { MobileMarkdown } from '../../../components/MobileMarkdown'
import { MobileAgentIcon } from '../../../components/MobileAgentIcon'
import { AgentStateDot } from '../../../components/AgentStateDot'
import { MobileSourceCopyButton } from '../../../components/MobileSourceCopyButton'
import { styles as markdownStyles } from '../../../components/mobile-markdown-styles'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { agentDotState } from '../../../worktree/agent-row-display'
import { resolveMobileTerminalTabAgentId } from '../../mobile-terminal-tab-agent'
import { MobileAgentMessageContext } from './mobile-agent-message-context'
import { MobileNativeChatMessageTime } from './MobileNativeChatMessageTime'
import { useMobileNativeChatDisclosure } from './mobile-native-chat-disclosure-store'
import { CHAT_PROSE_SCALE } from './mobile-native-chat-message-styles'

export const MobileNativeChatAgentMessageCard = memo(function MobileNativeChatAgentMessageCard({
  message,
  from,
  fontScale,
  attachments,
  onOpenFile,
  onLongPress,
  status
}: {
  message: NativeChatMessage
  from: AgentMessageSource
  fontScale: number
  attachments: React.ReactNode
  onOpenFile?: (path: string) => void
  onLongPress?: () => void
  status?: React.ReactNode
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const text = agentMessageTranscriptText(message.blocks, from)
  const [open, setOpen] = useMobileNativeChatDisclosure(`agent-message:${message.id}`, false)
  const [height, setHeight] = useState(0)
  const lineHeight = markdownStyles.paragraph.lineHeight * CHAT_PROSE_SCALE * fontScale
  const overflows = agentMessageOverflows(height, lineHeight)
  const heading = {
    task: t('chat.agentMessage.taskFromCoordinator', 'Task from your coordinator'),
    coordinator: t('chat.agentMessage.messageFromCoordinator', 'Message from your coordinator'),
    worker: t('chat.agentMessage.updateFromWorker', 'Update from your worker'),
    generic: t('chat.agentMessage.messageFrom', 'Message from')
  }[agentMessageHeading(from)]
  return (
    <View style={styles.card} testID="agent-message-card">
      <SenderAvatar sender={agentMessagePrimarySender(from)} />
      <View style={styles.content}>
        <View style={styles.heading}>
          <Text style={styles.meta}>{heading}</Text>
          <MobileNativeChatMessageTime timestamp={message.timestamp} fontScale={fontScale} />
        </View>
        <Senders from={from} />
        {attachments}
        <View
          style={
            !open
              ? { maxHeight: lineHeight * AGENT_MESSAGE_FOLDED_LINES, overflow: 'hidden' }
              : undefined
          }
        >
          <View
            style={styles.body}
            onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
          >
            <MobileMarkdown
              content={text}
              rangeSelectable
              textScale={CHAT_PROSE_SCALE * fontScale}
              onOpenFile={onOpenFile}
              onLongPress={onLongPress}
            />
          </View>
        </View>
        {status}
        <View style={styles.heading}>
          {overflows ? (
            <Pressable
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              onPress={() => setOpen(!open)}
            >
              <Text style={styles.toggle}>
                {agentMessageFoldLabel(open) === 'expanded'
                  ? t('chat.nativeChatUserMessageFold.showLess', 'Show less')
                  : t('chat.agentMessage.showMore', 'Show more')}
              </Text>
            </Pressable>
          ) : (
            <View />
          )}
          {agentMessageCanCopy(text) ? (
            <MobileSourceCopyButton
              text={text}
              accessibilityLabel={t('chat.message.copyMessage', 'Copy message')}
            />
          ) : null}
        </View>
      </View>
    </View>
  )
})

function SenderAvatar({ sender }: { sender: AgentMessageSource['senders'][number] | undefined }) {
  const { tabsBySender, now } = useContext(MobileAgentMessageContext)
  const tab = tabsBySender.get(sender?.party.orcaSessionId ?? sender?.party.terminalHandle ?? '')
  const status =
    tab?.type === 'terminal'
      ? tab.agentStatus
      : tab?.type === 'agent-session'
        ? tab.chatStatus
        : undefined
  const agentType =
    tab?.type === 'agent-session'
      ? tab.agent
      : tab?.type === 'terminal'
        ? (resolveMobileTerminalTabAgentId(tab) ?? undefined)
        : undefined
  const view = agentMessageSenderView(
    status && !(tab?.type === 'terminal' && tab.agentStatus?.restoredUnconfirmed)
      ? { agentType, dot: agentDotState(status, now) }
      : undefined,
    agentType
  )
  return (
    <View style={styles.avatar}>
      {view.agentType ? (
        <MobileAgentIcon agentId={view.agentType} size={16} />
      ) : (
        <Bot size={16} color={colors.textMuted} />
      )}
      {view.dot && view.dot !== 'permission' ? (
        <View style={styles.glyph}>
          <AgentStateDot state={view.dot} />
        </View>
      ) : null}
    </View>
  )
}

function Senders({ from }: { from: AgentMessageSource }) {
  const { tabsBySender, open } = useContext(MobileAgentMessageContext)
  const t = useMobileTranslation()
  const { shown, more } = agentMessageSendersShown(from)
  return (
    <View style={styles.senders}>
      {shown.length === 0 ? (
        <Text style={styles.name}>
          {t('session.agentMessageAttribution.unnamedSender', 'an agent')}
        </Text>
      ) : null}
      {shown.map((sender, index) => {
        const tab = tabsBySender.get(
          sender.party.orcaSessionId ?? sender.party.terminalHandle ?? ''
        )
        const name = agentMessageSenderLabel({
          localChat: tab?.type === 'agent-session',
          customLabel: tab?.title,
          snapshotName: sender.name,
          tabLabel: tab?.title,
          fallback: t('session.agentMessageAttribution.unnamedSender', 'an agent')
        })
        const canOpen = agentMessageSenderCanOpen(sender, open !== undefined)
        return (
          <Pressable
            key={index}
            disabled={!canOpen}
            accessibilityRole={canOpen ? 'button' : undefined}
            onPress={() => open?.(from, sender)}
            style={styles.sender}
          >
            <Text style={styles.name}>{name}</Text>
            {canOpen ? <ArrowUpRight size={14} color={colors.textPrimary} /> : null}
          </Pressable>
        )
      })}
      {more > 0 ? <Text style={styles.meta}>+{more}</Text> : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel
  },
  content: { flex: 1, minWidth: 0, gap: spacing.xs },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  meta: { color: colors.textMuted, fontSize: typography.metaSize, flexShrink: 1 },
  senders: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  sender: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  name: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600',
    flexShrink: 1
  },
  toggle: { color: colors.textMuted, fontSize: typography.metaSize, paddingVertical: spacing.xs },
  body: { flexShrink: 0 },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  glyph: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel
  }
}))
