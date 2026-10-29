import { describe, expect, it, vi } from 'vitest'
import {
  getEffectiveGitUpstreamStatus,
  resolveEffectiveGitUpstream
} from './git-effective-upstream'

describe('qualified upstream metadata binding', () => {
  it.each([
    { name: 'missing branch', output: '' },
    { name: 'prefix child without an upstream', output: 'refs/heads/topic/child\0\0\0\0\n' },
    {
      name: 'changed upstream spelling',
      output: 'refs/heads/topic\0refs/remotes/origin/main\0origin/main\0origin\0refs/heads/main\n'
    }
  ])('rejects $name instead of selecting a fallback target', async ({ output }) => {
    const runGit = async (args: string[]): Promise<{ stdout: string }> => {
      switch (args[0]) {
        case 'symbolic-ref':
          return { stdout: 'refs/heads/topic\n' }
        case 'rev-parse':
          return { stdout: 'remotes/origin/main\n' }
        case 'for-each-ref':
          return { stdout: output }
        default:
          throw new Error(`Unexpected command: ${args.join(' ')}`)
      }
    }

    await expect(resolveEffectiveGitUpstream(runGit)).rejects.toThrow(
      'Unable to resolve qualified configured upstream'
    )
  })
})

const URL = 'ssh://contributor@example.test/project.git'
const COMPARISON_REF = 'refs/remotes/fork/topic'
const UNSTORED_UPSTREAM =
  "fatal: upstream branch 'refs/heads/topic' not stored as a remote-tracking branch\n"

function urlUpstreamRunner(failingCommand?: string, failure?: Error) {
  const original = Object.assign(new Error(UNSTORED_UPSTREAM), { code: 128 })
  const runGit = vi.fn(async (args: string[]) => {
    if (args[0] === failingCommand) {
      throw failure
    }
    switch (args[0]) {
      case 'symbolic-ref':
        return { stdout: 'refs/heads/topic\n' }
      case 'rev-parse':
        throw original
      case 'config':
        return {
          stdout: [
            `branch.topic.remote\n${URL}\0`,
            'branch.topic.merge\nrefs/heads/topic\0',
            `remote.fork.url\n${URL}\0`,
            'remote.fork.fetch\n+refs/heads/*:refs/remotes/fork/*\0'
          ].join('')
        }
      case 'remote':
        return { stdout: `fork\t${URL} (fetch)\n` }
      case 'for-each-ref':
        return { stdout: `${COMPARISON_REF}\0\n` }
      case 'rev-list':
        return { stdout: '1\t1\n' }
      default:
        throw new Error(`Unexpected command: ${args.join(' ')}`)
    }
  })
  return { runGit, original }
}

describe('URL-configured upstream recovery contracts', () => {
  it('binds divergent counts and patch-equivalence to the canonical ref', async () => {
    const { runGit } = urlUpstreamRunner()
    const patchEquivalent = vi.fn(async () => false)
    const comparisonRef = vi.fn()

    await expect(
      getEffectiveGitUpstreamStatus(runGit, patchEquivalent, comparisonRef)
    ).resolves.toEqual({
      hasUpstream: true,
      upstreamName: 'fork/topic',
      ahead: 1,
      behind: 1,
      behindCommitsArePatchEquivalent: false
    })
    expect(patchEquivalent).toHaveBeenCalledWith(COMPARISON_REF)
    expect(comparisonRef).toHaveBeenCalledWith(COMPARISON_REF)
    expect(runGit).toHaveBeenCalledWith([
      'rev-list',
      '--left-right',
      '--count',
      `HEAD...${COMPARISON_REF}`
    ])
  })

  it.each(['config', 'remote', 'for-each-ref', 'rev-list'])(
    'preserves a %s probe error instead of trying another source',
    async (command) => {
      const failure = Object.assign(new Error('read failed'), { code: 'EIO' })
      const { runGit } = urlUpstreamRunner(command, failure)

      await expect(getEffectiveGitUpstreamStatus(runGit)).rejects.toBe(failure)
    }
  )

  it.each([
    { killed: true, signal: 'SIGTERM', code: 128 },
    { name: 'AbortError', code: 128 },
    { code: 'EIO' }
  ])('preserves a native-looking process failure: %j', async (attributes) => {
    const failure = Object.assign(new Error(UNSTORED_UPSTREAM), attributes)
    const { runGit } = urlUpstreamRunner('rev-parse', failure)

    await expect(resolveEffectiveGitUpstream(runGit)).rejects.toBe(failure)
    expect(runGit.mock.calls.map(([args]) => args[0])).toEqual(['symbolic-ref', 'rev-parse'])
  })
})
