import { describe, expect, it } from 'vitest'
import { resolveEffectiveGitUpstream } from './git-effective-upstream'

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
