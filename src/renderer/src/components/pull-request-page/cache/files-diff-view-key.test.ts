import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'
import { getPRFilesDiffViewKey } from './files-diff-view'

const identities: Parameters<typeof getPRFilesDiffViewKey>[0][] = [
  {
    repoId: 'repo',
    repoPath: '/repo',
    prNumber: 42,
    prRepo: { owner: 'owner', repo: 'repo', host: 'github.com' }
  },
  {
    repoId: '',
    repoPath: '/folder/repo',
    prNumber: 43,
    prRepo: null,
    sourceHostId: 'runtime:host'
  },
  {
    repoId: 'repo',
    repoPath: '/repo',
    prNumber: 44,
    prRepo: { owner: 'owner', repo: 'repo', host: 'github.example.com' },
    sourceHostId: 'ssh:host'
  }
]

describe('PR Files view key compatibility', () => {
  it('preserves the original inline key for local, remote and path-only identities', () => {
    for (const { repoId, repoPath, prNumber, prRepo, sourceHostId } of identities) {
      const sourceScope = sourceHostId ?? LOCAL_EXECUTION_HOST_ID
      expect(getPRFilesDiffViewKey({ repoId, repoPath, prNumber, prRepo, sourceHostId })).toBe(
        [
          repoId || repoPath,
          prNumber,
          prRepo ? githubRepoIdentityKey(prRepo) : '',
          sourceScope
        ].join('\0')
      )
    }
  })
})
