import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NewWorkspaceComposerNameSection } from './NewWorkspaceComposerNameSection'

function BranchReusePreview({ busy = false }: { busy?: boolean }) {
  const [reuse, setReuse] = useState(true)
  const [name, setName] = useState('Feature review')
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <NewWorkspaceComposerNameSection
        eligibleRepos={[]}
        repoId="repo"
        onRepoChange={() => {}}
        name={name}
        onNameValueChange={setName}
        onSmartGitHubItemSelect={() => {}}
        onSmartGitLabItemSelect={() => {}}
        onSmartBranchSelect={() => {}}
        onSmartLinearIssueSelect={() => {}}
        smartNameSelection={{ kind: 'branch', label: 'origin/feature/nested' }}
        onClearSmartNameSelection={() => {}}
        selectedRepoRequiresConnection={false}
        selectedRepoIsGit
        branchesEnabled
        forkPushWarning={null}
        canReuseSelectedBranch
        reuseSelectedBranch={reuse}
        onReuseSelectedBranchChange={setReuse}
        onOpenSelectedBranchWorkspace={busy && reuse ? () => {} : undefined}
        baseBranch="refs/remotes/origin/feature/nested"
        onNamePlainEnter={() => {}}
      />
    </div>
  )
}

export const remoteBranch = defineFixture({ width: 480, render: () => <BranchReusePreview /> })
export const busyBranch = defineFixture({ width: 480, render: () => <BranchReusePreview busy /> })
export const narrow = defineFixture({ width: 320, render: () => <BranchReusePreview busy /> })
