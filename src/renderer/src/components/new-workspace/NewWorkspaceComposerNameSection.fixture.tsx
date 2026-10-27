import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NewWorkspaceComposerNameSection } from './NewWorkspaceComposerNameSection'

function BranchReusePreview({
  busy = false,
  remote = true,
  initialReuse = true
}: {
  busy?: boolean
  remote?: boolean
  initialReuse?: boolean
}) {
  const [reuse, setReuse] = useState(initialReuse)
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
        smartNameSelection={{
          kind: 'branch',
          label: remote ? 'origin/feature/nested' : 'feature/nested'
        }}
        onClearSmartNameSelection={() => {}}
        selectedRepoRequiresConnection={false}
        selectedRepoIsGit
        branchesEnabled
        forkPushWarning={null}
        canReuseSelectedBranch
        reuseSelectedBranch={reuse}
        onReuseSelectedBranchChange={setReuse}
        onOpenSelectedBranchWorkspace={busy && reuse ? () => {} : undefined}
        baseBranch={remote ? 'refs/remotes/origin/feature/nested' : 'refs/heads/feature/nested'}
        onNamePlainEnter={() => {}}
      />
    </div>
  )
}

export const remoteBranch = defineFixture({ width: 480, render: () => <BranchReusePreview /> })
export const busyBranch = defineFixture({ width: 480, render: () => <BranchReusePreview busy /> })
export const narrow = defineFixture({ width: 320, render: () => <BranchReusePreview busy /> })
export const localBranch = defineFixture({
  width: 480,
  render: () => <BranchReusePreview remote={false} />
})
export const newBranch = defineFixture({
  width: 480,
  render: () => <BranchReusePreview key="new-branch" initialReuse={false} />
})
