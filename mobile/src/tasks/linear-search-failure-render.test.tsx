// @vitest-environment happy-dom
import { useEffect, useRef, useState } from 'react'
import { useMobileTasksTaskListLoading } from './use-mobile-tasks-task-list-loading'
import { MobileTasksLegacySurface } from './MobileTasksLegacySurface'
import type { ProviderLoadActionsModel } from './use-mobile-tasks-provider-load-actions'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SmartWorkspaceSourceDrawer } from '../components/SmartWorkspaceSourceDrawer'
import { useMobileComposerSource } from './use-mobile-composer-source'
import { searchIssues } from '../../../src/main/linear/linear-issue-lookups'
import { credentialDecryptionMessage } from '../../../src/shared/integration-credential-errors'
import { LINEAR_METHODS } from '../../../src/main/runtime/rpc/methods/linear'
import { mapDispatcherError } from '../../../src/main/runtime/rpc/dispatcher-error-response'
import { successResponse } from '../../../src/main/runtime/rpc/errors'
import type { RpcContext } from '../../../src/main/runtime/rpc/core'
import type { RpcClient } from '../transport/rpc-client'

const provider = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../../../src/main/linear/client', () => ({
  getClients: () => [
    { workspace: { id: 'w' }, client: { client: { rawRequest: provider.request } } }
  ],
  isAuthError: (error: unknown) => error instanceof Error && error.message.startsWith('401')
}))
vi.mock('../../../src/main/linear/linear-token-store', () => ({ clearToken: vi.fn() }))
vi.mock('../../../src/main/linear/linear-request-concurrency', () => ({
  acquire: async () => {},
  release: () => {}
}))
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const View = ({ children }: { children?: React.ReactNode }) =>
    createElement('div', null, children)
  return {
    Text: ({ children }: { children?: React.ReactNode }) => createElement('span', null, children),
    View,
    Pressable: ({ children, onPress }: { children?: React.ReactNode; onPress: () => void }) =>
      createElement('button', { onClick: onPress }, children),
    TextInput: () => null,
    FlatList: () => null,
    ActivityIndicator: () => null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    InteractionManager: { runAfterInteractions: () => ({ cancel: () => {} }) }
  }
})
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children: unknown }) => children
}))
vi.mock('../components/SmartSourceModeIcon', () => ({ SmartSourceModeIcon: () => null }))
vi.mock('../components/SmartWorkspaceSourceRow', () => ({ SmartWorkspaceSourceRow: () => null }))

const searchMethod = LINEAR_METHODS.find((method) => method.name === 'linear.searchIssues')!
// SAFETY: only linear.searchIssues is dispatched; the production handler uses this runtime method alone.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production phone search surface reads the explicitly supplied RPC/list dependencies; unrelated mobile screen services are intentionally inert.
const context = { runtime: { linearSearchIssues: searchIssues } } as unknown as RpcContext
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production phone search surface reads the explicitly supplied RPC/list dependencies; unrelated mobile screen services are intentionally inert.
const client = {
  sendRequest: async (_method: string, params: unknown) => {
    const request = { id: '1', authToken: '', method: searchMethod.name, params }
    const meta = { runtimeId: 'r' }
    try {
      return successResponse(
        request.id,
        meta,
        await searchMethod.handler(searchMethod.params.parse(params), context)
      )
    } catch (error) {
      return mapDispatcherError(request, meta, error)
    }
  }
  // SAFETY: the mounted search flow uses only sendRequest; no connection methods are called.
} as unknown as RpcClient
const availability = {
  textOnly: false,
  tasksSupported: true,
  hasRepo: false,
  githubAvailable: false,
  gitlabAvailable: false,
  linearAvailable: true,
  jiraAvailable: false
}
const repos: [] = []
function Picker() {
  const composer = useMobileComposerSource({ client, selectedRepoId: null })
  useEffect(() => composer.setName('network issue'), [composer.setName])
  return (
    <SmartWorkspaceSourceDrawer
      visible
      client={client}
      composer={composer}
      availability={availability}
      repoId={null}
      repos={repos}
      linearWorkspaceId="w"
      sshReady={false}
      onRepoChange={() => {}}
      onClose={() => {}}
    />
  )
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it.each([
  ['401 private provider diagnostic', 'Unable to load Linear issues. Try again.'],
  ['429: GraphQL request failed private diagnostic', 'Unable to load Linear issues. Try again.'],
  [credentialDecryptionMessage('Linear'), credentialDecryptionMessage('Linear')]
])('renders the real provider rejection safely: %s', async (raw, visible) => {
  provider.request.mockRejectedValue(new Error(raw))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  render(<Picker />)
  fireEvent.click(screen.getByRole('button', { name: 'Linear' }))
  await waitFor(() => expect(screen.queryByText(visible)).not.toBeNull())
  if (raw !== visible) {
    expect(screen.queryByText(raw)).toBeNull()
  }
  if (!raw.startsWith('401')) {
    expect(warn).toHaveBeenCalledWith(
      '[linear] searchIssues failed:',
      expect.objectContaining({ message: raw })
    )
  }
})

vi.mock('./mobile-tasks-dependencies', async () => {
  const react = await import('react')
  const View = ({ children }: { children?: React.ReactNode }) =>
    react.createElement('div', null, children)
  return {
    ...react,
    View,
    Text: View,
    SafeAreaView: View,
    BottomDrawerModalHost: View,
    ActionSheetModal: () => null,
    ConfirmModal: () => null,
    AlertTriangle: () => null,
    GitBranch: () => null,
    colors: {},
    useMobileColorScheme: () => 'light'
  }
})
vi.mock('./mobile-tasks-legacy-styles', () => ({ styles: {} }))
vi.mock('./mobile-tasks-legacy-foundation', () => ({ LINEAR_LIMIT: 100 }))
vi.mock('./mobile-tasks-screen-chrome', () => ({ renderMobileTasksChrome: () => null }))
vi.mock('./mobile-tasks-list-surface', () => ({ renderMobileTasksListSurface: () => null }))
vi.mock('./mobile-tasks-provider-pickers', () => ({
  renderMobileTasksProviderPicker: () => null,
  renderMobileTasksRepoPicker: () => null,
  renderMobileTasksGitHubIssueSourcePicker: () => null,
  renderMobileTasksGitHubViewPicker: () => null,
  renderMobileTasksGitHubPresetPicker: () => null,
  renderMobileTasksPagePicker: () => null
}))
vi.mock('./mobile-tasks-github-project-pickers', () => ({
  renderMobileTasksGitHubProjectPicker: () => null,
  renderMobileTasksGitHubProjectViewPicker: () => null,
  renderMobileTasksGitHubProjectSortPicker: () => null
}))
vi.mock('./mobile-tasks-filter-pickers', () => ({
  renderMobileTasksGitHubProjectFieldsPicker: () => null,
  renderMobileTasksGitLabViewPicker: () => null,
  renderMobileTasksGitLabFilterPicker: () => null,
  renderMobileTasksJiraFilterPicker: () => null,
  renderMobileTasksJiraSitePicker: () => null,
  renderMobileTasksLinearFilterPicker: () => null,
  renderMobileTasksLinearWorkspacePicker: () => null,
  renderMobileTasksLinearTeamPicker: () => null,
  renderMobileTasksLinearStatusPicker: () => null
}))
vi.mock('./mobile-tasks-list-display-pickers', () => ({
  renderMobileTasksLinearViewPicker: () => null,
  renderMobileTasksLinearGroupPicker: () => null,
  renderMobileTasksLinearOrderPicker: () => null,
  renderMobileTasksLinearDisplayPicker: () => null,
  renderMobileTasksSortPicker: () => null
}))
vi.mock('./mobile-tasks-create-drawers', () => ({
  renderMobileTasksCreateDrawer: () => null,
  renderMobileTasksCreateTargetPicker: () => null,
  renderMobileTasksLinearConnectDrawer: () => null,
  renderMobileTasksWorkspaceCreateTargetPicker: () => null
}))
vi.mock('./mobile-tasks-workspace-create-drawer', () => ({
  renderMobileTasksWorkspaceCreateDrawer: () => null,
  renderMobileTasksWorkspaceCreateRepoPicker: () => null,
  renderMobileTasksWorkspaceAgentPicker: () => null
}))
vi.mock('./mobile-tasks-workspace-option-pickers', () => ({
  renderMobileTasksWorkspaceBaseBranchPicker: () => null,
  renderMobileTasksWorkspaceSparsePicker: () => null
}))
vi.mock('./mobile-tasks-workspace-trust-drawers', () => ({
  renderMobileTasksWorkspaceSparseDrawer: () => null,
  renderMobileTasksSetupTrustDrawer: () => null,
  renderMobileTasksOrcaYamlTrustDrawer: () => null
}))
vi.mock('./mobile-tasks-project-detail-drawer', () => ({
  renderMobileTasksProjectMissingRepoDrawer: () => null,
  renderMobileTasksProjectDetailDrawer: () => null
}))
vi.mock('./mobile-tasks-item-detail-drawer', () => ({
  renderMobileTasksItemDetailDrawer: () => null
}))
function Tasks() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const clientRef = useRef(client),
    loadGenerationRef = useRef(0)
  const model = {
    appliedQuery: 'network issue',
    client,
    clientRef,
    loadGenerationRef,
    connState: 'connected',
    tasksSupported: true,
    taskStateHydrated: true,
    provider: 'linear',
    linearConnected: true,
    linearFilter: 'all',
    selectedLinearWorkspaceId: 'w',
    selectedLinearTeamIds: new Set<string>(),
    linearOrderBy: 'updatedAt',
    effectiveRepoIds: new Set<string>(),
    serverRepoList: [],
    repoListEnsureLoaded: async () => [],
    resetGitHubItemsState: () => {},
    setError,
    setLoading,
    setRefreshing: () => {},
    setItems: () => {},
    error,
    loading
  }
  // SAFETY: the actual Linear search branch uses precisely these fields; unrelated screen controls are omitted.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production phone search surface reads the explicitly supplied RPC/list dependencies; unrelated mobile screen services are intentionally inert.
  const actions = useMobileTasksTaskListLoading(model as unknown as ProviderLoadActionsModel)
  useEffect(() => {
    void actions.loadTasks()
  }, [])
  // SAFETY: shipping error banner reads error/provider/loading; unrelated drawers/chrome are mocked above.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production phone search surface reads the explicitly supplied RPC/list dependencies; unrelated mobile screen services are intentionally inert.
  return <MobileTasksLegacySurface model={actions as unknown as ConnectionPresentationModel} />
}
it('shipping phone Tasks renders the safe real main/RPC search failure', async () => {
  const raw = '429: GraphQL request failed private phone Tasks diagnostic'
  provider.request.mockRejectedValue(new Error(raw))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  render(<Tasks />)
  await waitFor(() =>
    expect(screen.getByText('Unable to load Linear issues. Try again.')).toBeTruthy()
  )
  expect(screen.queryByText(raw)).toBeNull()
  if (!raw.startsWith('401')) {
    expect(warn).toHaveBeenCalledWith(
      '[linear] searchIssues failed:',
      expect.objectContaining({ message: raw })
    )
  }
})
