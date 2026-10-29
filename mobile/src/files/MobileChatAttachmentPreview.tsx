import { createMobileChatAttachmentReader } from './mobile-chat-attachment-read'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMemo, useState, useEffect, useCallback } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { createAttachmentTextPreviewHook } from '../../../src/shared/use-attachment-text-preview'
import { chatTextAttachmentName } from '../../../src/shared/native-chat-text-attachment-references'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../src/shared/mobile-bridge-frame-bytes'
import { useClipboardWriter } from '../platform/clipboard'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import type { MobileFilePreviewRouteParams } from './mobile-file-preview-route'

const useAttachmentTextPreview = createAttachmentTextPreviewHook({
  useState,
  useEffect,
  useCallback
})

export function MobileChatAttachmentPreview({ params }: { params: MobileFilePreviewRouteParams }) {
  useMobileColorScheme()
  const { client, state } = useWorkspaceClient(params.hostId)
  const router = useWorkspaceRouteHandoff()
  const clipboard = useClipboardWriter()
  const path = params.absolutePath ?? ''
  const connectedAt = client?.getLastConnectedAt()
  const generation = client?.getGeneration?.()
  const read = useMemo(
    () => createMobileChatAttachmentReader(client),
    [client, connectedAt, generation, state]
  )
  const { source, display, busy, error, setError, setBusy, load, retry } = useAttachmentTextPreview(
    path,
    read
  )
  // Reserve envelope space, then validate actual JSON escaping before publishing to the phone clipboard.
  const smallCopy = source.size !== null && source.size + 4096 <= MOBILE_BRIDGE_MAX_FRAME_BYTES
  const copy = async () => {
    setBusy(true)
    try {
      const text = await source.copyText()
      if (
        new TextEncoder().encode(JSON.stringify({ value: text })).length + 4096 >
        MOBILE_BRIDGE_MAX_FRAME_BYTES
      ) {
        throw new Error('Full Copy for this attachment needs the upcoming phone update.')
      }
      source.assertCurrent()
      await clipboard.writeText(text)
    } catch (cause) {
      if (!source.disposed) {
        setError(cause instanceof Error ? cause.message : 'Unable to copy attachment. Try again.')
      }
    } finally {
      if (!source.disposed) {
        setBusy(false)
      }
    }
  }

  const action = (label: string, disabled: boolean, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.backButton, disabled && styles.saveButtonDisabled]}
    >
      <Text style={styles.meta}>{label}</Text>
    </Pressable>
  )
  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.header}>
        <View style={styles.topBar}>
          {action('Back', false, () => {
            source.dispose()
            router.back()
          })}
          <View style={styles.titleBlock}>
            <Text numberOfLines={1} style={styles.title}>
              {chatTextAttachmentName(path)}
            </Text>
            <Text style={styles.meta}>
              {source.size === null
                ? 'Text attachment'
                : `${source.size.toLocaleString(getUiIntlLocale())} bytes`}
            </Text>
          </View>
        </View>
      </SafeAreaView>
      <View style={styles.topBar}>
        {action('Copy', busy || !smallCopy, () => void copy())}
        {action('Save', true, () => {})}
        {action('Retry', busy, retry)}
      </View>
      <Text style={styles.meta}>
        {smallCopy
          ? 'Save will be available in a phone update.'
          : 'Full Copy and Save for this attachment will be available in a phone update.'}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
      ) : null}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.textContent}>
        {display?.segments.map((segment, index) => (
          <Text key={index} selectable style={styles.textPreview}>
            {segment.replace(/\n$/, '') || '\u00a0'}
          </Text>
        ))}
      </ScrollView>
      <View style={[styles.topBar, { flexWrap: 'wrap' }]}>
        {action('First', busy || !display, () => void load(0))}
        {action(
          'Prev',
          busy || !display || (display.page === 0 && display.subpage === 0),
          () =>
            display &&
            void load(
              display.subpage ? display.page : display.page - 1,
              display.subpage ? display.subpage - 1 : Number.MAX_SAFE_INTEGER
            )
        )}
        <TextInput
          accessibilityLabel="Attachment page"
          style={styles.meta}
          keyboardType="number-pad"
          value={String((display?.page ?? 0) + 1)}
          editable={!busy}
          onChangeText={(value) => {
            const page = Number(value)
            if (Number.isInteger(page) && page >= 1 && page <= source.pageCount) {
              void load(page - 1)
            }
          }}
        />
        <Text style={styles.meta}>
          / {source.pageCount}
          {display ? ` (${display.subpage + 1}/${display.subpages})` : ''}
        </Text>
        {action(
          'Next',
          busy ||
            !display ||
            (display.page + 1 === source.pageCount && display.subpage + 1 === display.subpages),
          () =>
            display &&
            void load(
              display.subpage + 1 < display.subpages ? display.page : display.page + 1,
              display.subpage + 1 < display.subpages ? display.subpage + 1 : 0
            )
        )}
        {action(
          'Last',
          busy || !display,
          () => void load(source.pageCount - 1, Number.MAX_SAFE_INTEGER)
        )}
      </View>
    </View>
  )
}
