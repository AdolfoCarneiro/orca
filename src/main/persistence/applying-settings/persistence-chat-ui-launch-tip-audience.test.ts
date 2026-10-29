import {
  closeTestStores,
  testState,
  createStore,
  readDataFile,
  writeDataFile
} from '../persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-chat-ui-launch-tip-audience-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

async function reopen(): Promise<ReturnType<typeof createStore>> {
  await closeTestStores()
  return createStore()
}

describe('Chat UI launch tip audience', () => {
  it.each([
    ['saved before the Chat UI switch existed', {}, 'eligible', 'chat-ui-off'],
    ['Chat UI off', { experimentalNativeChat: false }, 'eligible', 'chat-ui-off'],
    ['Chat UI on', { experimentalNativeChat: true }, 'eligible', 'chat-ui-on'],
    [
      'Chat UI on with new tabs opening in the terminal',
      { experimentalNativeChat: true, openAgentTabsInChatByDefault: false },
      'eligible',
      'chat-ui-off'
    ]
  ])('records an existing profile %s once', async (_, settings, membership, basis) => {
    writeDataFile({ settings })
    const store = createStore()
    store.flush()
    const record = { version: 1, membership, basis }
    expect(readDataFile()).toHaveProperty('chatUiLaunchTipAudience', record)
    expect(readDataFile()).not.toHaveProperty('settings.experimentalNativeChat')

    // The switch is gone from the saved profile, so later loads must keep the record, not rederive it.
    const reopened = await reopen()
    reopened.flush()
    expect(readDataFile()).toHaveProperty('chatUiLaunchTipAudience', record)
  })

  it('keeps a brand new profile out of the audience', () => {
    createStore().flush()
    expect(readDataFile()).toHaveProperty('chatUiLaunchTipAudience', {
      version: 1,
      membership: 'excluded',
      basis: 'new-profile'
    })
  })

  it.each([
    ['malformed', { membership: 'eligible' }],
    ['from a future version', { version: 2, membership: 'eligible', basis: 'chat-ui-off' }]
  ])('fails closed on a %s record instead of rederiving it', (_, chatUiLaunchTipAudience) => {
    writeDataFile({ settings: { experimentalNativeChat: false }, chatUiLaunchTipAudience })
    createStore().flush()
    expect(readDataFile()).toHaveProperty('chatUiLaunchTipAudience', {
      version: 1,
      membership: 'excluded',
      basis: 'unreadable-record'
    })
  })

  it('drops the retired upgrade tip audience record', () => {
    writeDataFile({
      settings: {},
      nativeChatUpgradeTipAudience: { version: 1, membership: 'eligible', basis: 'chat-ui-on' }
    })
    createStore().flush()
    expect(readDataFile()).not.toHaveProperty('nativeChatUpgradeTipAudience')
  })
})

describe('carrying what launches opened while Chat UI was experimental', () => {
  it.each([
    ['saved before the Chat UI switch existed', {}, undefined],
    ['Chat UI off', { experimentalNativeChat: false }, undefined],
    ['Chat UI on', { experimentalNativeChat: true }, EVERY_AGENT_CHAT],
    [
      'Chat UI off, turning chat choices the switch masked to CLI',
      { experimentalNativeChat: false, nativeChatProviders: { claude: true, codex: false } },
      { claude: false, codex: false }
    ],
    [
      'Chat UI on with new tabs opening in the terminal',
      {
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: false,
        nativeChatProviders: { codex: true }
      },
      { codex: false }
    ],
    [
      'Chat UI on, keeping an explicit CLI choice',
      { experimentalNativeChat: true, nativeChatProviders: { claude: false, 'acme-agent': true } },
      { ...EVERY_AGENT_CHAT, claude: false, 'acme-agent': true }
    ]
  ])('saves the choices of a profile %s, once', async (_, settings, carried) => {
    writeDataFile({ settings })
    const store = createStore()
    expect(store.getSettings().nativeChatProviders).toEqual(carried)
    store.flush()

    // A later choice survives the next load.
    store.updateSettings({ nativeChatProviders: { gemini: true } })
    store.flush()
    expect((await reopen()).getSettings().nativeChatProviders).toEqual({ gemini: true })
  })

  it('writes no choices for a brand new profile', () => {
    expect(createStore().getSettings().nativeChatProviders).toBeUndefined()
  })

  it('writes no choices when the audience record already exists, even malformed', () => {
    const nativeChatProviders = { claude: true }
    writeDataFile({
      settings: { experimentalNativeChat: false, nativeChatProviders },
      chatUiLaunchTipAudience: { membership: 'eligible' }
    })
    expect(createStore().getSettings().nativeChatProviders).toEqual(nativeChatProviders)
  })
})
