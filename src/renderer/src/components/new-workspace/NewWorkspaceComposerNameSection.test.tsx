// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewWorkspaceComposerNameSection } from './NewWorkspaceComposerNameSection'

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: ({ value, selectedSource }: { value: string; selectedSource?: { label: string } }) => (
    <div>
      <span>{selectedSource?.label}</span>
      <input aria-label="Workspace name" value={value} readOnly />
    </div>
  )
}))

function branchProps(): React.ComponentProps<typeof NewWorkspaceComposerNameSection> {
  return {
    eligibleRepos: [],
    repoId: 'repo',
    onRepoChange: vi.fn(),
    name: 'Payments review',
    onNameValueChange: vi.fn(),
    onSmartGitHubItemSelect: vi.fn(),
    onSmartGitLabItemSelect: vi.fn(),
    onSmartBranchSelect: vi.fn(),
    onSmartLinearIssueSelect: vi.fn(),
    smartNameSelection: { kind: 'branch', label: 'origin/feature/payments' },
    onClearSmartNameSelection: vi.fn(),
    selectedRepoRequiresConnection: false,
    selectedRepoIsGit: true,
    branchesEnabled: true,
    forkPushWarning: null,
    canReuseSelectedBranch: true,
    reuseSelectedBranch: true,
    onReuseSelectedBranchChange: vi.fn(),
    baseBranch: 'refs/remotes/origin/feature/payments',
    onNamePlainEnter: vi.fn()
  }
}

afterEach(cleanup)

describe('NewWorkspaceComposerNameSection branch reuse', () => {
  it('offers toggling reuse of the selected remote branch without changing the workspace name', async () => {
    const user = userEvent.setup()
    const props = branchProps()
    const { rerender } = render(<NewWorkspaceComposerNameSection {...props} />)

    expect(screen.getByText('origin/feature/payments')).toBeTruthy()
    expect(
      screen.getByRole('checkbox', { name: 'Reuse branch' }).getAttribute('aria-checked')
    ).toBe('true')
    await user.click(screen.getByRole('checkbox', { name: 'Reuse branch' }))
    expect(props.onReuseSelectedBranchChange).toHaveBeenLastCalledWith(false)

    rerender(<NewWorkspaceComposerNameSection {...props} reuseSelectedBranch={false} />)
    expect(
      screen.getByRole('checkbox', { name: 'Reuse branch' }).getAttribute('aria-checked')
    ).toBe('false')
    await user.click(screen.getByRole('checkbox', { name: 'Reuse branch' }))
    expect(props.onReuseSelectedBranchChange).toHaveBeenLastCalledWith(true)
    expect(props.onNameValueChange).not.toHaveBeenCalled()
    expect(props.onClearSmartNameSelection).not.toHaveBeenCalled()
  })

  it('opens the existing workspace with the keyboard without submitting or changing branch intent', async () => {
    const user = userEvent.setup()
    const props = branchProps()
    const openWorkspace = vi.fn()
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <form onSubmit={submit}>
        <NewWorkspaceComposerNameSection {...props} onOpenSelectedBranchWorkspace={openWorkspace} />
      </form>
    )

    const openButton = screen.getByRole('button', { name: 'Open existing workspace' })
    await user.tab()
    await user.tab()
    await user.tab()
    expect(document.activeElement).toBe(openButton)
    await user.keyboard('{Enter}')

    expect(openWorkspace).toHaveBeenCalledOnce()
    expect(submit).not.toHaveBeenCalled()
    expect(props.onReuseSelectedBranchChange).not.toHaveBeenCalled()
    expect(props.onNameValueChange).not.toHaveBeenCalled()
    expect(props.onClearSmartNameSelection).not.toHaveBeenCalled()
  })

  it('removes the open action when the composer clears its existing-workspace target', () => {
    const props = branchProps()
    const { rerender } = render(
      <NewWorkspaceComposerNameSection {...props} onOpenSelectedBranchWorkspace={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: 'Open existing workspace' })).toBeTruthy()

    rerender(<NewWorkspaceComposerNameSection {...props} reuseSelectedBranch={false} />)

    expect(screen.queryByRole('button', { name: 'Open existing workspace' })).toBeNull()
    expect(
      screen.getByRole('checkbox', { name: 'Reuse branch' }).getAttribute('aria-checked')
    ).toBe('false')
  })

  it('keeps reuse controls out of the accessible UI for a folder workspace', () => {
    render(
      <NewWorkspaceComposerNameSection
        {...branchProps()}
        selectedRepoIsGit={false}
        smartNameSelection={null}
        canReuseSelectedBranch={false}
        reuseSelectedBranch={false}
      />
    )

    expect(screen.queryByRole('checkbox', { name: 'Reuse branch' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open existing workspace' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Workspace name' })).toBeTruthy()
  })
})
