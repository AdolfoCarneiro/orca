// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS, type FeatureTip } from '../../../../shared/feature-tips'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ChatUiLaunchTipVariant } from '../../../../shared/native-chat/chat-ui-launch-tip-audience'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { chatDemoRevealTokens, getChatDemoCopy } from './chat-ui-here-feature-tip-demo'
import { FeatureTipActions } from './FeatureTipActions'
import FeatureTipsModal from './FeatureTipsModal'

vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const updateSettings = vi.fn()
const updateSettingsOrThrow = vi.fn()

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  root = createRoot(container)
  updateSettings.mockReset()
  vi.mocked(track).mockReset()
  updateSettingsOrThrow.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => root.unmount())
})

function openTip(variant: ChatUiLaunchTipVariant): void {
  useAppStore.setState({
    activeModal: 'feature-tips',
    modalData: { tipId: 'chat-ui-here', source: 'app_open' },
    chatUiLaunchTipVariant: variant,
    settings: {
      nativeChatProviders: { codex: false },
      aiVaultSearch: { enabled: false, historyDays: null }
    } as GlobalSettings,
    markFeatureTipsSeen: vi.fn(),
    updateSettings,
    updateSettingsOrThrow
  })
  act(() => root.render(<FeatureTipsModal />))
}

function footerButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('footer button'))
}

describe('Chat UI is here tip', () => {
  it('saves Chat for every known agent with Use Chat UI, and nothing with Stay in terminal', async () => {
    openTip('chat-ui-off')
    expect(footerButtons().map((button) => button.textContent)).toEqual([
      'Stay in terminal',
      'Use Chat UI'
    ])
    act(() => footerButtons()[0]?.click())
    expect(useAppStore.getState().activeModal).toBe('none')
    expect(track).toHaveBeenLastCalledWith('chat_ui_feature_tip_action', {
      variant: 'chat_ui_off',
      action: 'stay_in_terminal'
    })

    openTip('chat-ui-off')
    await act(async () => footerButtons()[1]?.click())
    expect(useAppStore.getState().activeModal).toBe('none')
    expect(updateSettingsOrThrow).toHaveBeenCalledExactlyOnceWith({
      nativeChatProviders: Object.fromEntries(
        Object.keys(TUI_AGENT_CONFIG).map((agent) => [agent, true])
      )
    })
    expect(updateSettings).not.toHaveBeenCalled()
    expect(track).toHaveBeenLastCalledWith('chat_ui_feature_tip_action', {
      variant: 'chat_ui_off',
      action: 'use_chat_ui'
    })
  })

  it('offers chat users a single Got it that closes without saving', async () => {
    openTip('chat-ui-on')
    expect(footerButtons().map((button) => button.textContent)).toEqual(['Got it'])
    await act(async () => footerButtons()[0]?.click())
    expect(useAppStore.getState().activeModal).toBe('none')
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('renders nothing for a profile outside the audience, even when named', () => {
    openTip('none')
    expect(container.innerHTML).toBe('')
  })

  it('reveals the reply word by word around an untranslated file link, in any script', () => {
    const reply = getChatDemoCopy().reply
    expect(reply.map((token) => token.text).join('')).toBe(
      'Login starts in auth.ts: the browser posts to /login, the server checks the password and creates a session, then redirects you to the app. Here’s the flow:'
    )
    expect(reply.filter((token) => token.link)).toEqual([{ text: 'auth.ts', link: true }])
    expect(reply[0]).toEqual({ text: 'Login ' })
    // Japanese has no spaces; it still streams in several steps instead of one block.
    const japanese = 'ブラウザが /login に送信し、サーバーがパスワードを確認します。'
    const tokens = chatDemoRevealTokens(japanese)
    expect(tokens.map((token) => token.text).join('')).toBe(japanese)
    expect(tokens.length).toBeGreaterThan(5)
  })

  it('keeps the other tips’ default secondary label', () => {
    const tip = FEATURE_TIPS.find((entry) => entry.id === 'voice-dictation') as FeatureTip
    act(() =>
      root.render(
        <FeatureTipActions
          currentTip={tip}
          primaryBusy={false}
          onPrimaryAction={vi.fn()}
          onSkip={vi.fn()}
        />
      )
    )
    expect(container.querySelector('button')?.textContent).toBe('Maybe Later')
  })
})
