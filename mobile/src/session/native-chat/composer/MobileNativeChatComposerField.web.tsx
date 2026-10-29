import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { mobileNativeChatInputStyles as inputStyles } from './mobile-native-chat-input-styles'
import {
  mobileNativeChatComposerSkillStyles as skillStyles,
  type MobileNativeChatComposerFieldProps
} from './mobile-native-chat-composer-field-skill'

// Textareas cannot style tokens: hide their text under a styled copy while preserving the caret. RN types omit caretColor.
function clearText() {
  return { field: { color: 'transparent', caretColor: colors.textPrimary } }
}

function scrollTopOf(event: unknown): number {
  const target =
    typeof event === 'object' && event !== null && 'currentTarget' in event
      ? event.currentTarget
      : null
  return typeof target === 'object' &&
    target !== null &&
    'scrollTop' in target &&
    typeof target.scrollTop === 'number'
    ? target.scrollTop
    : 0
}

function withoutHeightCap<T extends { maxHeight?: unknown }>({ maxHeight: _cap, ...style }: T) {
  return style
}

function TokenText({ text, skillToken }: { text: string; skillToken: string | null }) {
  if (!skillToken || !text.startsWith(skillToken)) {
    return text
  }
  return (
    <>
      <Text style={skillStyles.token}>{skillToken}</Text>
      {text.slice(skillToken.length)}
    </>
  )
}

export function MobileNativeChatComposerField({
  value,
  skillToken,
  dictationPreview,
  placeholder,
  ref,
  ...props
}: MobileNativeChatComposerFieldProps) {
  useMobileColorScheme()
  const [scrollTop, setScrollTop] = useState(0)
  const [fieldHeight, setFieldHeight] = useState(0)
  const [heardEnd, setHeardEnd] = useState(0)
  const copied = Boolean(skillToken || dictationPreview)
  // The copy grows past the field's height cap so it can be shifted; the frame clips it.
  const copyStyle = copied ? withoutHeightCap(StyleSheet.flatten(inputStyles.input)) : null
  // While dictating, the line holding the newest word sits at the field's bottom, whatever the draft holds after it.
  const shift = dictationPreview ? Math.min(0, fieldHeight - heardEnd) : -scrollTop
  // Keep one tree so adding/removing a skill or dictation cannot remount the field and drop focus.
  return (
    <View
      style={styles.frame}
      onLayout={(event) => setFieldHeight(event.nativeEvent.layout.height)}
    >
      {copied ? (
        // Dictation never writes the textarea: that would end the keyboard's own dictation or IME input.
        <View pointerEvents="none" style={styles.copyLayer}>
          <Text aria-hidden style={[copyStyle, { transform: [{ translateY: shift }] }]}>
            {dictationPreview ? (
              <>
                <TokenText text={dictationPreview.before} skillToken={skillToken} />
                <Text style={skillStyles.dictationPreview}>{dictationPreview.text}</Text>
                {dictationPreview.after}
              </>
            ) : (
              <TokenText text={value} skillToken={skillToken} />
            )}
          </Text>
          {dictationPreview ? (
            <Text
              aria-hidden
              style={[copyStyle, styles.measure]}
              onLayout={(event) => setHeardEnd(event.nativeEvent.layout.height)}
            >
              {dictationPreview.before}
              {dictationPreview.text}
            </Text>
          ) : null}
        </View>
      ) : null}
      <TextInput
        ref={ref}
        value={value}
        style={copied ? [inputStyles.input, clearText().field] : inputStyles.input}
        onScroll={skillToken ? (event) => setScrollTop(scrollTopOf(event)) : undefined}
        placeholder={dictationPreview ? undefined : placeholder}
        {...props}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    overflow: 'hidden'
  },
  copyLayer: {
    ...StyleSheet.absoluteFillObject
  },
  measure: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    opacity: 0
  }
})
