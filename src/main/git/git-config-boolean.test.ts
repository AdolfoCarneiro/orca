import { describe, expect, it } from 'vitest'
import { parseGitConfigFlag } from './git-config-boolean'

describe('parseGitConfigFlag', () => {
  it('reads any plain section/key and keeps the last matching assignment', () => {
    const config =
      '[extensions] worktreeConfig = false\n' +
      '[extensions "sub"] worktreeConfig = false\n' +
      '[EXTENSIONS] WORKTREECONFIG = y"e"s\n' +
      '[core] worktreeConfig = false\n'
    expect(parseGitConfigFlag(config, 'extensions', 'worktreeconfig')).toBe(true)
    expect(parseGitConfigFlag(config, 'extensions', 'missing')).toBeUndefined()
  })

  it('distinguishes absent, implicit and explicit empty values for fallback', () => {
    expect(parseGitConfigFlag('[core]\n', 'core', 'bare')).toBeUndefined()
    expect(parseGitConfigFlag('[core] bare\n', 'core', 'bare')).toBe(true)
    expect(parseGitConfigFlag('[core] bare =\n', 'core', 'bare')).toBe(false)
    expect(parseGitConfigFlag('[core] bare = ""\n', 'core', 'bare')).toBe(false)
    expect(parseGitConfigFlag('[core] bare = "unclosed\n', 'core', 'bare')).toBe(false)
  })

  it.each(['"true "', '" true"', 'true\\t', 'tr\tue', 'true\t""'])(
    'preserves decoded whitespace in %s',
    (value) => {
      expect(parseGitConfigFlag(`[core] bare = ${value}\n`, 'core', 'bare')).toBe(false)
    }
  )

  it.each([
    { value: '-2147483647', expected: true },
    { value: '-2147483648', expected: false },
    { value: '0b1', expected: false }
  ])('uses the portable numeric policy for $value', ({ value, expected }) => {
    expect(parseGitConfigFlag(`[core] bare = ${value}\n`, 'core', 'bare')).toBe(expected)
  })
})
