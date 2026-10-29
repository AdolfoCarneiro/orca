import { describe, expect, it } from 'vitest'
import { scanGitConfigAssignments } from './git-config-assignments'

describe('scanGitConfigAssignments', () => {
  it('distinguishes valueless keys from unusable explicit values', () => {
    const assignments = [
      ...scanGitConfigAssignments(
        '[Core] ENABLED # comment\nenabled =\nenabled = ""\nenabled = bad\\q\n'
      )
    ]

    expect(assignments.map((assignment) => assignment.value)).toEqual([
      { kind: 'implicit' },
      { kind: 'explicit', decoded: null },
      { kind: 'explicit', decoded: null },
      { kind: 'explicit', decoded: null }
    ])
    expect(assignments.every((assignment) => assignment.key === 'enabled')).toBe(true)
  })

  it('consumes unrelated continued values before selecting the next assignment section', () => {
    expect([
      ...scanGitConfigAssignments(
        '[include] ignored = prefix\\\n[core]\nPATH = child.cfg\n[includeIf "onbranch:*"] path = conditional.cfg\n'
      )
    ]).toEqual([
      {
        section: { name: 'include', hasSubsection: false },
        key: 'ignored',
        value: { kind: 'explicit', decoded: { value: 'prefix[core]' } }
      },
      {
        section: { name: 'include', hasSubsection: false },
        key: 'path',
        value: { kind: 'explicit', decoded: { value: 'child.cfg' } }
      },
      {
        section: { name: 'includeif', hasSubsection: true },
        key: 'path',
        value: { kind: 'explicit', decoded: { value: 'conditional.cfg' } }
      }
    ])
  })
})
