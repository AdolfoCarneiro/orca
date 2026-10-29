import { useRef, type JSX } from 'react'
import type { FeatureTip } from '../../../../shared/feature-tips'
import type { ChatUiLaunchTipVariant } from '../../../../shared/native-chat/chat-ui-launch-tip-audience'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { ChatUiHereFeatureTipVisual } from './ChatUiHereFeatureTipVisual'
import { FeatureTipActions } from './FeatureTipActions'
import {
  FeatureTipDialogFrame,
  FeatureTipEyebrow,
  FeatureTipSettingsLine
} from './FeatureTipDialogFrame'
import { getLocalizedFeatureTipCopy } from './feature-tip-localized-copy'

type ShownVariant = Exclude<ChatUiLaunchTipVariant, 'none'>

// Side by side, the buttons' bottom meets the bottom of the card's composer box: the gap below the
// centered 22rem card (the column is the frame less its 1px borders), the card's border, and the
// composer's bottom padding of three spacing steps at the card's 12px chat text.
const BUTTONS_ON_COMPOSER_EDGE =
  'md:pb-[calc((min(27rem,100vh-2rem)-2px-22rem)/2+1px+(12px*3/3.5))]'

function variantCopy(variant: ShownVariant): {
  paragraphs: string[]
  secondaryLabel: string | null
  primaryLabel: string
} {
  if (variant === 'chat-ui-off') {
    return {
      paragraphs: [
        translate(
          'featureTips.chatUiHere.offIntro',
          'Agents can now open as a chat, with rich messages, visuals, images and file links.'
        ),
        translate(
          'featureTips.chatUiHere.offTerminal',
          'Prefer the terminal? It stays fully supported and keeps getting better. Your agents keep opening there until you choose Chat.'
        )
      ],
      secondaryLabel: translate('featureTips.chatUiHere.stayInTerminal', 'Stay in terminal'),
      primaryLabel: translate('featureTips.chatUiHere.cta', 'Use Chat UI')
    }
  }
  return {
    paragraphs: [
      translate(
        'featureTips.chatUiHere.onIntro',
        'Chat UI is out of Experimental and now part of Orca. Your agents keep opening as chats, with rich messages, visuals, images and file links.'
      ),
      translate(
        'featureTips.chatUiHere.onTerminal',
        'The terminal stays fully supported too. Switch any agent back anytime.'
      )
    ],
    secondaryLabel: null,
    primaryLabel: translate('featureTips.gotIt', 'Got it')
  }
}

export function ChatUiHereTipDialog({
  open,
  tip,
  variant,
  onOpenChange,
  onPrimaryAction,
  onSettingsClick
}: {
  open: boolean
  tip: FeatureTip
  variant: ShownVariant
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
  onSettingsClick: () => void
}): JSX.Element {
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const copy = getLocalizedFeatureTipCopy(tip)
  const { paragraphs, secondaryLabel, primaryLabel } = variantCopy(variant)

  return (
    <FeatureTipDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        // Why: longer locales overflow the fixed frame; scrolling to the button would hide the title.
        primaryButtonRef.current?.focus({ preventScroll: true })
      }}
      visual={<ChatUiHereFeatureTipVisual />}
      copyClassName={BUTTONS_ON_COMPOSER_EDGE}
    >
      <DialogHeader className="gap-4 text-left">
        <div>
          <FeatureTipEyebrow label={copy.eyebrow} />
          <DialogTitle className="text-2xl font-semibold leading-tight tracking-tight md:text-[1.75rem]">
            {copy.title}
          </DialogTitle>
          <DialogDescription className="mt-3 max-w-2xl space-y-3 text-sm leading-relaxed">
            {paragraphs.map((paragraph) => (
              <span key={paragraph} className="block">
                {paragraph}
              </span>
            ))}
            <FeatureTipSettingsLine
              text={translate(
                'featureTips.chatUiHere.changeInSettings',
                'Change anytime in <link>Settings → Agents</link>.'
              )}
              onClick={onSettingsClick}
            />
          </DialogDescription>
        </div>
      </DialogHeader>

      <DialogFooter className="mt-8 flex sm:justify-stretch">
        <FeatureTipActions
          currentTip={tip}
          primaryBusy={false}
          onPrimaryAction={onPrimaryAction}
          onSkip={() => onOpenChange(false)}
          showSkip={secondaryLabel !== null}
          secondaryLabel={secondaryLabel ?? undefined}
          fullWidth
          primaryButtonRef={primaryButtonRef}
          label={primaryLabel}
        />
      </DialogFooter>
    </FeatureTipDialogFrame>
  )
}
