import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type {
  MobileWebShellSessionState,
  MobileWebShellUpdateNotice
} from './mobile-web-shell-session-contract'

// Exercise the real hook/store over in-memory disk; stub network and native modules.
type Doubles = {
  connection: { client: object | null; state: string }
  gates: {
    statusPending: boolean
    statusReadable: boolean
    hostCapabilities: string[]
    hostProtocolWindow: { protocolVersion: number; minCompatibleMobileVersion: number }
  }
  manifest: MobileWebBundleManifestRead | null
  fetch: () => Promise<MobileWebBundleFetchResult>
}

const doubles = vi.hoisted((): Doubles => ({
  connection: { client: {}, state: 'connected' },
  gates: {
    statusPending: false,
    statusReadable: true,
    hostCapabilities: [],
    hostProtocolWindow: { protocolVersion: 10, minCompatibleMobileVersion: 1 }
  },
  manifest: null,
  fetch: () => Promise.reject(new Error('no fetch staged'))
}))

vi.mock('expo-crypto', async () => {
  const { randomBytes } = await import('node:crypto')
  return { getRandomBytes: (length: number) => new Uint8Array(randomBytes(length)) }
})
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('../transport/mobile-endpoint-supervisor-support', () => ({
  encodeBase64Url: () => 'session-id'
}))
vi.mock('../components/host-protocol-gates-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/host-protocol-gates-context')>()
  return {
    ...actual,
    useHostProtocolGates: () => actual.useOptionalHostProtocolGates() ?? doubles.gates
  }
})
vi.mock('../transport/host-client-hooks', () => ({ useHostClient: () => doubles.connection }))
vi.mock('../transport/rpc-operation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport/rpc-operation')>()
  return {
    ...actual,
    runRpcOperation: async (...args: Parameters<typeof actual.runRpcOperation>) => {
      if (args[1].name !== 'mobileWeb.bundle-manifest') {
        return actual.runRpcOperation(...args)
      }
      if (doubles.manifest === null) {
        throw new Error('the test reached the host with no manifest staged')
      }
      return { manifest: doubles.manifest }
    }
  }
})
vi.mock('../transport/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: () => doubles.fetch()
}))

import {
  computeMobileWebBundleId,
  MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
  type MobileWebBundleAsset
} from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type { MobileWebBundleFetchResult } from '../transport/mobile-web-bundle-fetch'
import { MobileWebBundleFetchError } from '../transport/mobile-web-bundle-fetch-refusal'
import { MobileWebBundleManifestReadSchema } from '../transport/mobile-web-bundle-reply-schemas'
import {
  createFakeGenerationFileSystem,
  FAKE_GENERATION_ROOT,
  type FakeGenerationFileSystem
} from './generation-file-system-fake'
import { createGenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import { useMobileWebShellSession } from './use-mobile-web-shell-session'

const HOST_ID = 'host-1'
const HOST_KEY = deriveHostCacheKey(HOST_ID)
const ROUTE_PATHNAME = '/h/host-1'
const ROUTE_PATTERN = '/h/[hostId]'

function assetsFilled(fill: number) {
  return [
    { path: 'index.html', sha256: `${fill}`.repeat(64), byteLength: 4, contentType: 'text/html' },
    {
      path: 'assets/app.js',
      sha256: `${fill + 1}`.repeat(64),
      byteLength: 2,
      contentType: 'text/javascript'
    }
  ]
}

const GOOD_ASSETS = assetsFilled(1)
const NEWER_ASSETS = assetsFilled(5)
const TOTAL_BYTES = 6
// Derive ids from assets so cached fixtures pass the manifest digest check.
const GOOD_BUILD_ID = computeMobileWebBundleId(GOOD_ASSETS)
const NEWER_BUILD_ID = computeMobileWebBundleId(NEWER_ASSETS)

function manifestOf(
  assets: readonly MobileWebBundleAsset[],
  runtimeProtocolVersion = 5
): MobileWebBundleManifestRead {
  return MobileWebBundleManifestReadSchema.parse({
    schemaVersion: MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
    buildId: computeMobileWebBundleId(assets),
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion,
    pageVersion: 1,
    entrypoint: 'index.html',
    totalBytes: TOTAL_BYTES,
    assets,
    routes: [{ pathname: ROUTE_PATTERN, grants: ['navigate'] }]
  })
}

const GOOD_MANIFEST = manifestOf(GOOD_ASSETS)
const NEWER_MANIFEST = manifestOf(NEWER_ASSETS)
const STALE_MANIFEST = manifestOf(GOOD_ASSETS, 0)

function fetchResultFor(manifest: MobileWebBundleManifestRead): MobileWebBundleFetchResult {
  return {
    manifest,
    assets: new Map(
      manifest.assets.map((asset) => [asset.path, new Uint8Array(asset.byteLength).fill(7)])
    ),
    reused: [],
    totalBytes: TOTAL_BYTES,
    elapsedMs: 1
  }
}

// Stage/commit N through the real store so fallback reads the tree a successful download actually leaves.
async function cacheGeneration(
  fileSystem: FakeGenerationFileSystem,
  manifest: MobileWebBundleManifestRead = GOOD_MANIFEST
): Promise<void> {
  const store = createGenerationStore({ fileSystem })
  await store.commitGeneration(await store.stageGeneration(HOST_KEY, fetchResultFor(manifest)))
}

function refuseTheAssets(): Promise<MobileWebBundleFetchResult> {
  return Promise.reject(
    new MobileWebBundleFetchError(
      'asset-short',
      'bundle asset assets/app.js ended at 1 of 2 declared bytes'
    )
  )
}

type Mounted = {
  unmount: () => Promise<void>
  state: () => MobileWebShellSessionState
  updateNotice: () => MobileWebShellUpdateNotice | null
}

async function mountRoute(fileSystem: FakeGenerationFileSystem): Promise<Mounted> {
  const latest: {
    state: MobileWebShellSessionState
    updateNotice: MobileWebShellUpdateNotice | null
  } = { state: { kind: 'checking' }, updateNotice: null }
  function Probe() {
    const session = useMobileWebShellSession({
      hostId: HOST_ID,
      routePathname: ROUTE_PATHNAME,
      runtime: {
        createStore: () => createGenerationStore({ fileSystem }),
        mintSessionId: () => 'session-id',
        now: () => 0,
        setTimer: () => () => {}
      }
    })
    latest.state = session.state
    latest.updateNotice = session.updateNotice
    return null
  }
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(createElement(Probe))
  })
  const tree = rendered.tree
  if (tree === null) {
    throw new Error('the hook did not mount')
  }
  return {
    unmount: async () => {
      await act(async () => {
        tree.unmount()
      })
    },
    state: () => latest.state,
    updateNotice: () => latest.updateNotice
  }
}

const GENERATIONS_PREFIX = `${HOST_KEY}/generations/`

function generationTree(fileSystem: FakeGenerationFileSystem): readonly string[] {
  return fileSystem.paths().filter((path) => path.startsWith(GENERATIONS_PREFIX))
}

function cachedBuildIds(fileSystem: FakeGenerationFileSystem): readonly string[] {
  return [
    ...new Set(
      generationTree(fileSystem).map((path) => path.slice(GENERATIONS_PREFIX.length).split('/')[0])
    )
  ]
}

describe('an update the shell refuses while the host is reachable', () => {
  beforeEach(() => {
    doubles.connection = { client: {}, state: 'connected' }
    doubles.gates.hostCapabilities = [MOBILE_WEB_BUNDLE_CAPABILITY]
    doubles.manifest = NEWER_MANIFEST
    doubles.fetch = refuseTheAssets
  })

  it('serves the generation on disk instead of a wall, and says why', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)

    const mounted = await mountRoute(fileSystem)

    expect(mounted.state()).toMatchObject({ kind: 'ready', buildId: GOOD_BUILD_ID })
    expect(mounted.updateNotice()).toBe('update-failed')
  })

  it('leaves the refused generation off the disk and the intact one on it', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)
    const settled = generationTree(fileSystem)

    const mounted = await mountRoute(fileSystem)
    expect(mounted.state()).toMatchObject({ kind: 'ready' })

    expect(cachedBuildIds(fileSystem)).toEqual([GOOD_BUILD_ID])
    expect(generationTree(fileSystem)).toEqual(settled)
    expect(fileSystem.paths().filter((path) => path.includes('/tmp'))).toEqual([])
  })

  it('walls as it always did when there is no generation to fall back to', async () => {
    const fileSystem = createFakeGenerationFileSystem()

    const mounted = await mountRoute(fileSystem)

    expect(mounted.state()).toEqual({
      kind: 'failed',
      reason: 'download-failed',
      retriedOnce: false
    })
    expect(mounted.updateNotice()).toBeNull()
  })

  it('walls a generation whose declared runtime the host has moved past', async () => {
    // Decide compatibility from the persisted manifest beside the cached bytes, not an injected value.
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem, STALE_MANIFEST)

    const mounted = await mountRoute(fileSystem)

    expect(mounted.state()).toEqual({
      kind: 'wall',
      verdict: {
        kind: 'blocked',
        reason: 'bundle-incompatible',
        side: 'mobile',
        bundleRuntimeProtocolVersion: 0,
        requiredBundleRuntimeProtocolVersion: 1
      }
    })
    expect(mounted.updateNotice()).toBeNull()
    expect(cachedBuildIds(fileSystem)).toEqual([GOOD_BUILD_ID])
  })

  it('writes down why on the device, which is all a release build keeps', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)

    const mounted = await mountRoute(fileSystem)
    expect(mounted.state()).toMatchObject({ kind: 'ready', buildId: GOOD_BUILD_ID })

    expect(await createGenerationStore({ fileSystem }).readUpdateFailures()).toEqual([
      {
        hostId: HOST_ID,
        at: 0,
        reason: 'asset-short',
        hostCode: null,
        offeredBuildId: NEWER_BUILD_ID,
        cachedBuildId: GOOD_BUILD_ID,
        outcome: 'opened-cached',
        wall: null
      }
    ])
  })

  it('records a failure whose error named an endpoint and a token without either', async () => {
    doubles.fetch = () =>
      Promise.reject(new Error('dial wss://relay.example/pair?token=SECRET-123 refused'))
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)

    await mountRoute(fileSystem)

    const log = await fileSystem.readText(`${FAKE_GENERATION_ROOT}/update-failures.json`)
    expect(log).toContain('unrecognised-error')
    expect(log).not.toMatch(/SECRET|token|\?|:\/\/|relay/)
  })

  it("forgets this host's failures once a newer generation commits, and no other host's", async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)
    const other = {
      hostId: 'host-2',
      at: 0,
      reason: 'connection-lost',
      hostCode: null,
      offeredBuildId: null,
      cachedBuildId: null,
      outcome: 'opened-cached',
      wall: null
    } as const
    await createGenerationStore({ fileSystem }).recordUpdateFailure(other)

    await (await mountRoute(fileSystem)).unmount()
    const afterRefusal = await createGenerationStore({ fileSystem }).readUpdateFailures()
    expect(afterRefusal.map((entry) => entry.hostId)).toEqual(['host-2', HOST_ID])

    doubles.fetch = () => Promise.resolve(fetchResultFor(NEWER_MANIFEST))
    const updated = await mountRoute(fileSystem)
    expect(updated.state()).toMatchObject({ kind: 'ready', buildId: NEWER_BUILD_ID })

    expect(await createGenerationStore({ fileSystem }).readUpdateFailures()).toEqual([other])
  })

  it('asks the host again on the next launch rather than living under the fallback', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)

    const refused = await mountRoute(fileSystem)
    expect(refused.state()).toMatchObject({ kind: 'ready', buildId: GOOD_BUILD_ID })
    await refused.unmount()

    doubles.fetch = () => Promise.resolve(fetchResultFor(NEWER_MANIFEST))
    const updated = await mountRoute(fileSystem)

    expect(updated.state()).toMatchObject({ kind: 'ready', buildId: NEWER_BUILD_ID })
    expect(updated.updateNotice()).toBeNull()
    expect(cachedBuildIds(fileSystem)).toEqual([NEWER_BUILD_ID])
  })
})

// Native presentation and identity are inert; controls, preference owners, bridge and socket are real.
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios', select: (v: { ios?: unknown }) => v.ios },
  StyleSheet: { create: <T>(v: T) => v, hairlineWidth: 1 },
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Switch: 'Switch',
  InteractionManager: { runAfterInteractions: () => ({ cancel: () => {} }) }
}))
vi.mock('lucide-react-native', () => new Proxy({}, { get: (_t, key) => key, has: () => true }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))
vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {}
}))
vi.mock('../transport/host-app-version-store', () => ({ recordHostAppVersion: async () => {} }))
vi.mock('../transport/host-descriptor-recorder', () => ({
  recordHostDescriptorFromStatus: () => {}
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../../src/main/telemetry/client', () => ({ track: vi.fn() }))

import WebSocket from 'ws'
import {
  testState,
  closeTestStores,
  createStore,
  readDataFile
} from '../../../src/main/persistence/persistence-test-harness'
import { createProjectGroupingSocketOwner } from '../../../src/main/persistence/applying-settings/project-grouping-socket-owner.test-fixture'
import { DirectRpcClient } from '../transport/direct-rpc-client'
import { createBridgePortPair } from './bridge/bridge-port-pair-test-harness'
import { useHostStatusGates } from '../transport/host-status-gates'
import {
  HostStatusGatesContext,
  useOptionalHostProtocolGates
} from '../components/host-protocol-gates-context'
import { useHostScreenState } from '../host-screen/use-host-screen-state'
import { useHostViewSettings } from '../host-screen/use-host-view-settings'
import { useHostViewSettings as useReleasedSettings } from '../host-screen/project-grouping-released-view-settings.test-fixture'
import { ProjectsPage as ReleasedProjectsPage } from '../host-screen/project-grouping-released-project-page.test-fixture'
import { WORKSPACE_OPTION_CONTROLS } from '../host-screen/workspace-option-controls'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { buildFilterRepos } from '../worktree/workspace-filter-repos'
import type { RpcClient } from '../transport/rpc-client'
import type { HostScreenController } from '../host-screen/use-host-screen-controller'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'

it.each(['released-page/current-native', 'current-page/released-native'] as const)(
  'joins failed-download compatible cache, %s controls, opaque bridge, auth and disk',
  async (composition) => {
    expect(ORCA_SIDEBAR_INPUTS_IS_MAIN).toBe(false)
    const owner = await createProjectGroupingSocketOwner({ deviceScope: 'mobile' })
    vi.stubGlobal('WebSocket', WebSocket)
    const endpoint = owner.environment.endpoints[0]
    // Physical sender and opaque bridge are byte-identical to the released version; pins are in review evidence.
    const direct = new DirectRpcClient(
      endpoint.endpoint,
      endpoint.deviceToken,
      endpoint.publicKeyB64,
      {}
    )
    const Q = 'runtime:server\0same'
    const renders: ReactTestRenderer[] = []
    const controlFrames = new Map<RpcClient, unknown>()
    let cached: Mounted | undefined
    let pair: ReturnType<typeof createBridgePortPair> | undefined
    const catalogRepos = [
      {
        id: 'same',
        displayName: 'Local',
        path: '/local',
        badgeColor: '',
        addedAt: 0,
        upstream: { owner: 'org', repo: 'app' }
      },
      {
        id: 'same',
        displayName: 'Server',
        upstream: { owner: 'org', repo: 'app' },
        path: '/server',
        executionHostId: 'runtime:server' as const,
        badgeColor: '',
        addedAt: 0
      }
    ]
    const projection = projectHostSetupProjectionFromRepos(catalogRepos)
    const groupedRepos = buildFilterRepos(catalogRepos, [], {
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings: { projectGroupingMode: 'folder' }
    })
    const rawRepos = buildFilterRepos(catalogRepos, [])
    const mountControls = async (client: RpcClient, released: boolean) => {
      const Control = released
        ? ReleasedProjectsPage
        : WORKSPACE_OPTION_CONTROLS.projects.kind === 'page'
          ? WORKSPACE_OPTION_CONTROLS.projects.Page
          : null
      if (!Control) {
        throw new Error('Missing Project page')
      }
      function GateOwner() {
        const gates = useHostStatusGates({
          client,
          hostId: HOST_ID,
          connState: client.getState()
        })
        return createElement(
          HostStatusGatesContext.Provider,
          { value: gates },
          createElement(Controls)
        )
      }
      function Controls() {
        const gates = useOptionalHostProtocolGates()
        const state = useHostScreenState(HOST_ID)
        const current = useHostViewSettings({ client, connState: 'connected', state })
        const old = useReleasedSettings({ client, connState: 'connected', state })
        const settings = released ? old : current
        controlFrames.set(client, {
          released,
          selected: state.view.filters.filterRepoIds,
          ready: current.projectRepoFiltersReady,
          actionError: state.actionError,
          statusPending: gates?.statusPending,
          statusReadable: gates?.statusReadable,
          support: gates?.projectRepoFilterSupport,
          generation: gates?.statusGeneration
        })
        useEffect(() => {
          state.clientRef.current = client
          void settings.syncViewSettingsFromDesktop()
        }, [client])
        // SAFETY: real state and settings supply every reached Project-page field; unrelated host-screen sections are outside this fixture.
        const controller = {
          state,
          settings,
          sectionsResult: { uniqueRepos: released ? rawRepos : groupedRepos }
        } as unknown as HostScreenController
        return createElement(Control, { controller, hosts: [], label: 'Projects' })
      }
      let tree!: ReactTestRenderer
      await act(async () => {
        tree = create(createElement(GateOwner))
      })
      renders.push(tree)
      return tree
    }
    const press = async (tree: ReactTestRenderer, label: string) => {
      const row = () =>
        tree.root.findByProps({
          accessibilityLabel: label,
          accessibilityRole: 'checkbox'
        })
      await vi.waitFor(() => expect(row().props.disabled).not.toBe(true))
      await act(async () => row().props.onPress())
    }
    try {
      await vi.waitFor(() => expect(direct.getState()).toBe('connected'))
      doubles.connection = { client: direct, state: 'connected' }
      doubles.gates.hostCapabilities = [MOBILE_WEB_BUNDLE_CAPABILITY]
      doubles.manifest = NEWER_MANIFEST
      doubles.fetch = refuseTheAssets
      const fileSystem = createFakeGenerationFileSystem()
      await cacheGeneration(fileSystem)
      cached = await mountRoute(fileSystem)
      expect(cached.state()).toMatchObject({ kind: 'ready', buildId: GOOD_BUILD_ID })
      expect(cached.updateNotice()).toBe('update-failed')
      pair = createBridgePortPair({
        rpc: direct,
        buildId: GOOD_BUILD_ID,
        route: { pathname: ROUTE_PATHNAME },
        pageRoutes: [ROUTE_PATTERN],
        sessionEstablished: true
      })
      await pair.flush()
      owner.store.updateUI({ filterRepoIds: ['same', Q] })
      const page = await mountControls(pair.client, composition.startsWith('released'))
      await vi.waitFor(() =>
        expect(
          page.root.findByProps({ accessibilityLabel: 'Local', accessibilityRole: 'checkbox' })
            .props.accessibilityState.checked
        ).toBe(true)
      )
      await press(page, 'Local')
      await vi.waitFor(() =>
        expect(owner.store.getUI().filterRepoIds).toEqual(
          composition.startsWith('released') ? [] : [Q]
        )
      )
      const pageEdit = owner.requests.findLast((r) => r.method === 'ui.set')
      expect(pageEdit?.params).toEqual(
        composition.startsWith('released')
          ? { filterRepoIds: [Q] }
          : { filterRepoIds: [Q], filterRepoIdsMode: 'exact' }
      )
      owner.store.updateUI({ filterRepoIds: [] })
      const native = await mountControls(direct, composition.endsWith('released-native'))
      expect(
        native.root.findByProps({
          accessibilityLabel: 'Server',
          accessibilityRole: 'checkbox'
        }).props.accessibilityState.checked
      ).toBe(false)
      await press(native, 'Server')
      await vi.waitFor(() =>
        expect(owner.requests.findLast((r) => r.method === 'ui.set')?.params).toEqual(
          composition.endsWith('released-native')
            ? { filterRepoIds: ['same'] }
            : { filterRepoIds: [Q], filterRepoIdsMode: 'exact' }
        )
      )
      await vi.waitFor(() =>
        expect(owner.store.getUI().filterRepoIds).toEqual(
          composition.endsWith('released-native') ? ['same'] : [Q]
        )
      )
      // Same physical socket's old raw re-entry never inherits another writer's exact meaning.
      await pair.client.sendRequest('ui.set', { filterRepoIds: [] })
      expect(owner.store.getUI().filterRepoIds).toEqual([])
      expect(
        owner.auth.every((entry) => !entry.capabilities.includes('ui.project-repo-filter-exact.v1'))
      ).toBe(true)
      const installs = owner.requests.filter(
        (r) => r.method === 'runtime.clientCapabilities.update'
      )
      expect(
        installs.every((r) => !JSON.stringify(r.params).includes('ui.project-repo-filter-exact'))
      ).toBe(true)
      owner.store.flush()
      expect(readDataFile().ui).not.toHaveProperty('filterRepoIdsMode')
      await closeTestStores()
      expect(createStore().getUI().filterRepoIds).toEqual([])
    } catch (error) {
      console.info(
        'PG35595 mixed-composition failure',
        JSON.stringify({
          composition,
          controls: [...controlFrames.values()],
          writes: owner.requests.filter((request) => request.method === 'ui.set'),
          ownerFilter: owner.store.getUI().filterRepoIds
        })
      )
      throw error
    } finally {
      await act(async () => renders.forEach((tree) => tree.unmount()))
      await cached?.unmount()
      pair?.client.close()
      pair?.host.dispose()
      direct.close()
      await owner.close()
      vi.unstubAllGlobals()
    }
  },
  20_000
)
