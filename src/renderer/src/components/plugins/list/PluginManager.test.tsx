// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../../preload/api-types'
import { PLUGIN_GROUP_ROW_CAP, PluginManager } from './PluginManager'
import { usePluginPageNavigation } from '../state/use-plugin-page-navigation'
import { getDefaultSettings } from '../../../../../shared/constants'
import { useAppStore } from '@/store'
import { usePluginThemeStore } from '@/store/plugin-themes'

vi.mock('../../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('../dialogs/PluginMarketplaceSourceDialog', () => ({
  PluginMarketplaceSourceDialog: () => null
}))

const installedPlugin: PluginHostListEntry = {
  pluginKey: 'stablyai.orca-nord-theme',
  consentFingerprint: 'sha256-nord',
  name: 'Orca Nord',
  version: '1.0.0',
  publisher: 'stablyai',
  status: 'idle',
  needsReconsent: false,
  isDev: false,
  official: true,
  bundled: false,
  capabilities: [],
  panels: [],
  commands: [],
  hasWorker: false,
  restarts: 0,
  source: {
    kind: 'marketplace',
    reference: 'https://example.invalid/nord.git',
    resolvedCommit: 'a'.repeat(40),
    contentHash: 'b'.repeat(64)
  }
}

const source: PluginMarketplaceHostSourceState = {
  id: 'official',
  source: { kind: 'git', url: 'https://example.invalid/catalog.git', ref: 'main' },
  addedAt: 0,
  marketplace: {
    name: 'Orca Official Plugins',
    owner: 'stablyai',
    resolvedCommit: 'c',
    fetchedAt: 0
  },
  stale: false,
  official: true
}

function listing(pluginKey: string, extra: Partial<PluginMarketplaceHostListing> = {}) {
  const value: PluginMarketplaceHostListing = {
    marketplaceSourceId: 'official',
    marketplaceName: 'Orca Official Plugins',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'c',
    pluginKey,
    source: { kind: 'git', url: 'https://example.invalid/plugin.git', ref: 'main' },
    description: `Description of ${pluginKey}`,
    categories: ['themes'],
    official: true,
    bundled: false,
    ...extra
  }
  return value
}

const catalogListings = [
  listing('stablyai.orca-nord-theme', {
    release: {
      version: '1.2.0',
      commit: 'd'.repeat(40),
      contentHash: 'e'.repeat(64),
      execution: 'data',
      minimumOrca: '1.4.0',
      types: ['app-theme'],
      name: 'Orca Nord'
    },
    license: 'MIT',
    changelog: 'Warmer comments.\n<b>not markup</b>'
  }),
  ...Array.from({ length: PLUGIN_GROUP_ROW_CAP + 2 }, (_, index) =>
    listing(`stablyai.extra-${index}`)
  )
]

let root: Root | null = null

function installApi(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        listMarketplaces: vi.fn().mockResolvedValue([source]),
        listMarketplacePlugins: vi.fn().mockResolvedValue(catalogListings),
        refreshMarketplaces: vi.fn().mockResolvedValue(undefined),
        previewMarketplacePlugin: vi.fn().mockResolvedValue(null),
        getRollbackVersion: vi.fn().mockResolvedValue('1.0.0-rc.1'),
        getInstalledManifest: vi.fn().mockResolvedValue(null),
        ...overrides
      },
      updater: { getVersion: vi.fn().mockResolvedValue('1.4.214') },
      ui: { writeClipboardText: vi.fn() }
    }
  })
}

function Harness({ plugins }: { plugins: PluginHostListEntry[] }): React.JSX.Element {
  const page = usePluginPageNavigation()
  return (
    <PluginManager
      plugins={plugins}
      pluginsLoading={false}
      pluginsError={null}
      busyPluginKeys={new Set()}
      handlers={{
        onReview: vi.fn(),
        onToggleEnabled: vi.fn(),
        onRestart: vi.fn(),
        onRollbackRequest: vi.fn(),
        onRemoveRequest: vi.fn()
      }}
      onRefreshInstalled={vi.fn().mockResolvedValue(undefined)}
      onInstalled={vi.fn().mockResolvedValue(undefined)}
      logsByPlugin={{}}
      onShowLogs={vi.fn()}
      onOpenShortcuts={vi.fn()}
      onOpenFullAccessSetting={vi.fn()}
      page={page}
      sourcesOpen={false}
      setSourcesOpen={vi.fn()}
      onConsent={vi.fn().mockResolvedValue(undefined)}
    />
  )
}

async function render(plugins: PluginHostListEntry[] = [installedPlugin]): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Harness plugins={plugins} />)
  })
  return container
}

function buttonNamed(container: HTMLElement, name: string | RegExp): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) => {
    const label = button.getAttribute('aria-label') ?? button.textContent ?? ''
    return typeof name === 'string' ? label === name : name.test(label)
  })
}

beforeEach(() => installApi())

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('PluginManager', () => {
  it('lists each catalog plugin once, in catalog order, capped with Show more', async () => {
    const container = await render()
    const catalogCards = (): Element[] =>
      Array.from(container.querySelectorAll('[data-plugin-key]')).filter(
        (card) => !card.closest('[data-installed-carousel]')
      )
    const rows = catalogCards().map((row) => row.getAttribute('data-plugin-key'))
    // Why one grid: an installed catalog plugin keeps its card, so installing never moves it.
    expect(rows.filter((key) => key === 'stablyai.orca-nord-theme')).toHaveLength(1)
    expect(rows).toHaveLength(PLUGIN_GROUP_ROW_CAP)

    await act(async () => buttonNamed(container, 'Show 3 more')?.click())
    expect(catalogCards()).toHaveLength(PLUGIN_GROUP_ROW_CAP + 3)
  })

  it('leads the All tab with installed plugins as cards, and See all opens Installed', async () => {
    const local: PluginHostListEntry = {
      ...installedPlugin,
      pluginKey: 'local.dev-theme',
      name: 'Dev Theme',
      isDev: true,
      official: false,
      types: ['app-theme'],
      source: undefined
    }
    const container = await render([installedPlugin, local])
    const carousel = container.querySelector('[data-installed-carousel]')
    expect(carousel?.querySelector('h3')?.textContent).toBe('Installed · 2')
    expect(
      Array.from(carousel?.querySelectorAll('[data-plugin-key]') ?? []).map((card) =>
        card.getAttribute('data-plugin-key')
      )
    ).toEqual(['stablyai.orca-nord-theme', 'local.dev-theme'])
    // Why: a dev plugin has no catalog category, so its contributed theme names its kind.
    expect(carousel?.querySelector('[data-plugin-key="local.dev-theme"]')?.textContent).toContain(
      'Themes'
    )

    await act(async () => buttonNamed(container, 'See all')?.click())
    expect(container.querySelector('[data-installed-carousel]')).toBeNull()
    expect(container.querySelectorAll('[data-plugin-key]')).toHaveLength(2)
  })

  it('labels cards by category with an icon, keeping a chip only for full access', async () => {
    const worker: PluginHostListEntry = {
      ...installedPlugin,
      pluginKey: 'local.watcher',
      name: 'Watcher',
      execution: 'trusted-worker',
      hasWorker: true,
      types: ['worker'],
      source: undefined
    }
    const container = await render([installedPlugin, worker])
    const nord = container.querySelector('[data-plugin-key="stablyai.orca-nord-theme"]')
    const watcher = container.querySelector('[data-plugin-key="local.watcher"]')
    expect(nord?.textContent).toContain('Themes')
    expect(nord?.textContent).not.toContain('Content only')
    expect(watcher?.textContent).toContain('Commands & panels')
    expect(watcher?.textContent).toContain('Full access')
  })

  it('shows In use for the active theme slot and Use when it is installed but not active', async () => {
    const theme = {
      id: 'plugin:local.dusk/dusk' as const,
      pluginKey: 'local.dusk',
      pluginName: 'Dusk',
      label: 'Dusk',
      revision: 'r1',
      base: 'dark' as const,
      tokens: {}
    }
    const dusk: PluginHostListEntry = {
      ...installedPlugin,
      pluginKey: 'local.dusk',
      name: 'Dusk',
      types: ['app-theme'],
      source: undefined
    }
    usePluginThemeStore.setState({ entries: [theme], loaded: true })
    useAppStore.setState({ settings: getDefaultSettings('/tmp') })
    const container = await render([dusk])
    const card = (): Element | null => container.querySelector('[data-plugin-key="local.dusk"]')
    expect(buttonNamed(container, 'Use Dusk')).toBeDefined()

    await act(async () =>
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), pluginAppThemeDark: theme.id }
      })
    )
    expect(card()?.textContent).toContain('In use · Dark')
    expect(buttonNamed(container, 'Use Dusk')).toBeUndefined()
    usePluginThemeStore.setState({ entries: [], loaded: false })
    useAppStore.setState({ settings: null })
  })

  it('hides the installed row when nothing is installed', async () => {
    const container = await render([])
    expect(container.querySelector('[data-installed-carousel]')).toBeNull()
  })

  it('offers a newer catalog version as the row action and counts it under Updates', async () => {
    const container = await render()
    const nord = container.querySelector('[data-plugin-key="stablyai.orca-nord-theme"]')
    expect(nord?.textContent).toContain('1.2.0')
    expect(buttonNamed(container, /^Updates/)?.getAttribute('aria-hidden')).not.toBe('true')
  })

  it('never says a content-only plugin crashed or points it at logs it has none of', async () => {
    const container = await render([
      {
        ...installedPlugin,
        pluginKey: 'local.lang-pack',
        name: 'Lang Pack',
        execution: 'data',
        status: 'errored',
        restarts: 2,
        source: {
          kind: 'local-path',
          reference: '/tmp/lang',
          resolvedCommit: null,
          contentHash: 'h'
        }
      }
    ])
    const row = container.querySelector('[data-plugin-key="local.lang-pack"]')
    expect(row?.textContent).toContain('Couldn’t load its files')
    expect(row?.textContent).not.toContain('Crashed')
  })

  it('keeps installed plugins when the catalog never loads', async () => {
    installApi({ listMarketplaces: vi.fn().mockRejectedValue(new Error('offline')) })
    const container = await render()
    expect(container.querySelector('[data-plugin-key="stablyai.orca-nord-theme"]')).not.toBeNull()
    expect(container.textContent).toContain('Couldn’t load the plugin catalog.')
  })

  it('opens a plugin page from its name and returns focus to that name', async () => {
    const container = await render()
    const name = container.querySelector<HTMLButtonElement>(
      '[data-plugin-key="stablyai.orca-nord-theme"] [data-plugin-row-name]'
    )
    expect(name?.getAttribute('aria-label')).toBe('Orca Nord, stablyai, On, update 1.2.0 available')

    await act(async () => name?.click())
    expect(container.querySelector('#plugin-detail-heading')?.textContent).toBe('Orca Nord')

    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true }))
    )
    const restored = container.querySelector(
      '[data-plugin-key="stablyai.orca-nord-theme"] [data-plugin-row-name]'
    )
    expect(document.activeElement).toBe(restored)
  })

  it('shows release notes as text, license and the rollback version on the plugin page', async () => {
    const container = await render()
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-plugin-key="stablyai.orca-nord-theme"] [data-plugin-row-name]'
        )
        ?.click()
    )
    expect(window.api.plugins.getRollbackVersion).toHaveBeenCalledWith({
      pluginKey: 'stablyai.orca-nord-theme'
    })
    expect(container.textContent).toContain('What’s new')
    expect(container.textContent).toContain('<b>not markup</b>')
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('MIT')
    expect(container.textContent).toContain('1.0.0-rc.1')
  })

  it('says when nothing matches and clears the search', async () => {
    const container = await render()
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search plugins"]')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'zzz')
      search?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('No plugins match “zzz”')

    await act(async () => buttonNamed(container, 'Clear search')?.click())
    expect(container.querySelectorAll('[data-plugin-key]').length).toBeGreaterThan(0)
  })
})
