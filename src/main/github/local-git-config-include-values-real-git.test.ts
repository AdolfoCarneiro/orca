import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitBinaryTestFixture } from '../../shared/git-binary.test-fixture'

vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../observability/tracer', () => ({
  withSpan: (_name: unknown, run: () => unknown) => run(),
  flushActiveSink: vi.fn(),
  startSpan: vi.fn()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { gitExecFileAsync } from '../git/runner'
import {
  _resetRemoteNameListingCache,
  listCachedRemoteNames,
  shouldProbeGitRemote
} from '../git/remote-name-listing'
import {
  __resetLocalGitConfigSignatureCacheForTests,
  readLocalGitConfigSignature
} from './local-git-config-signature'
import { _resetOwnerRepoCache, getOwnerRepoForRemote } from './github-repository-identity'
import { getOwnerRepo } from './github-owner-repo-selection'

type IncludePathCase = {
  name: string
  includedPath: string
  value: string
  posixOnly?: boolean
  otherIncludedPaths?: string[]
  expectedIncludedPaths?: string[]
  noFinalNewline?: boolean
  directivePrefix?: string
  includeKey?: string
}

const cases: IncludePathCase[] = [
  { name: 'unquoted', includedPath: 'includes/team.cfg', value: 'includes/team.cfg' },
  ...[
    { name: 'vertical tab', char: '\v', posixOnly: true },
    { name: 'form feed', char: '\f', posixOnly: true },
    { name: 'nonbreaking space', char: '\u00a0' },
    { name: 'ideographic space', char: '\u3000' }
  ].flatMap(({ name, char, posixOnly }) => [
    {
      name: `native whitespace leading ${name}`,
      includedPath: `${char}team.cfg`,
      value: `${char}team.cfg`,
      posixOnly
    },
    {
      name: `native whitespace trailing ${name}`,
      includedPath: `team.cfg${char}`,
      value: `team.cfg${char}# comment`,
      posixOnly
    },
    {
      name: `native whitespace quoted ${name}`,
      includedPath: `${char}team.cfg${char}`,
      value: `"${char}team.cfg${char}"`,
      posixOnly
    }
  ]),
  {
    name: 'quoted spaces',
    includedPath: 'includes/team cfg',
    value: '"includes/team cfg"  \t'
  },
  {
    name: 'comment after closing quote',
    includedPath: 'includes/team.cfg',
    value: '"includes/team.cfg"#comment'
  },
  {
    name: 'trailing unquoted whitespace',
    includedPath: 'includes/team.cfg',
    value: 'includes/team.cfg  \t'
  },
  {
    name: 'quoted comment delimiters',
    includedPath: 'includes/team#;cfg',
    value: '"includes/team#;cfg"'
  },
  {
    name: 'adjacent hash comment',
    includedPath: 'includes/team.cfg',
    value: 'includes/team.cfg#comment'
  },
  {
    name: 'adjacent semicolon comment',
    includedPath: 'includes/team.cfg',
    value: 'includes/team.cfg;comment'
  },
  {
    name: 'quoted suffix',
    includedPath: 'includes/team cfg',
    value: 'includes/"team cfg"'
  },
  {
    name: 'quoted prefix',
    includedPath: 'includes/team.cfg',
    value: '"includes/"team.cfg'
  },
  { name: 'literal single quotes', includedPath: "'team.cfg'", value: "'team.cfg'" },
  {
    name: 'escaped quote',
    includedPath: 'includes/team"cfg',
    value: '"includes/team\\"cfg"',
    posixOnly: true
  },
  {
    name: 'escaped backslash',
    includedPath: 'includes/team\\cfg',
    value: '"includes/team\\\\cfg"',
    posixOnly: true
  },
  {
    name: 'escaped tab',
    includedPath: 'includes/team\tcfg',
    value: '"includes/team\\tcfg"',
    posixOnly: true
  },
  {
    name: 'escaped newline',
    includedPath: 'includes/team\ncfg',
    value: '"includes/team\\ncfg"',
    posixOnly: true
  },
  {
    name: 'escaped backspace',
    includedPath: 'includes/team\bcfg',
    value: '"includes/team\\bcfg"',
    posixOnly: true
  },
  {
    name: 'unquoted escaped quote',
    includedPath: 'includes/team"cfg',
    value: 'includes/team\\"cfg',
    posixOnly: true
  },
  {
    name: 'unquoted escaped backslash',
    includedPath: 'includes/team\\cfg',
    value: 'includes/team\\\\cfg',
    posixOnly: true
  },
  {
    name: 'unquoted escaped tab',
    includedPath: 'includes/team\tcfg',
    value: 'includes/team\\tcfg',
    posixOnly: true
  },
  {
    name: 'unquoted escaped newline',
    includedPath: 'includes/team\ncfg',
    value: 'includes/team\\ncfg',
    posixOnly: true
  },
  {
    name: 'unquoted escaped backspace',
    includedPath: 'includes/team\bcfg',
    value: 'includes/team\\bcfg',
    posixOnly: true
  },
  {
    name: 'quoted trailing whitespace',
    includedPath: 'includes/team.cfg \t',
    value: '"includes/team.cfg \t"',
    posixOnly: true
  },
  {
    name: 'escaped trailing tab before a comment',
    includedPath: 'includes/team.cfg\t',
    value: 'includes/team.cfg\\t#comment',
    posixOnly: true
  },
  {
    name: 'whitespace before empty quotes',
    includedPath: 'includes/team.cfg  ',
    value: 'includes/team.cfg  ""',
    posixOnly: true
  },
  {
    name: 'unquoted lf',
    includedPath: 'includes/team.cfg',
    value: 'includes/te\\\nam.cfg'
  },
  {
    name: 'quoted lf',
    includedPath: 'includes/team.cfg',
    value: '"includes/te\\\nam.cfg"'
  },
  {
    name: 'quoted prefix then continuation',
    includedPath: 'includes/team.cfg',
    value: '"includes/te"\\\nam.cfg'
  },
  {
    name: 'continuation then quoted suffix',
    includedPath: 'includes/team.cfg',
    value: 'includes/te\\\n"am.cfg"'
  },
  {
    name: 'multiple lf',
    includedPath: 'includes/team.cfg',
    value: 'includes/te\\\nam\\\n.cfg'
  },
  {
    name: 'repeated empty continuation',
    includedPath: 'includes/team.cfg',
    value: 'includes/te\\\n\\\nam.cfg'
  },
  {
    name: 'quoted multiple lf',
    includedPath: 'includes/team.cfg',
    value: '"includes/te\\\nam\\\n.cfg"'
  },
  {
    name: 'unquoted crlf',
    includedPath: 'includes/team.cfg',
    value: 'includes/te\\\r\nam.cfg'
  },
  {
    name: 'quoted crlf',
    includedPath: 'includes/team.cfg',
    value: '"includes/te\\\r\nam.cfg"'
  },
  {
    name: 'multiple crlf',
    includedPath: 'includes/team.cfg',
    value: 'includes/te\\\r\nam\\\r\n.cfg'
  },
  {
    name: 'unquoted continuation indent spaces',
    includedPath: 'includes/te  am.cfg',
    value: 'includes/te\\\n  am.cfg'
  },
  {
    name: 'quoted continuation indent tab',
    includedPath: 'includes/te\tam.cfg',
    value: '"includes/te\\\n\tam.cfg"',
    posixOnly: true
  },
  {
    name: 'quoted hash before continuation',
    includedPath: 'includes/te#am.cfg',
    value: '"includes/te#\\\nam.cfg"'
  },
  {
    name: 'quoted semicolon before continuation',
    includedPath: 'includes/te;am.cfg',
    value: '"includes/te;\\\nam.cfg"'
  },
  {
    name: 'escaped quote before continuation',
    includedPath: 'includes/te"am.cfg',
    value: '"includes/te\\"\\\nam.cfg"',
    posixOnly: true
  },
  {
    name: 'three backslashes before newline',
    includedPath: 'includes/te\\am.cfg',
    value: 'includes/te\\\\\\\nam.cfg',
    posixOnly: true
  },
  {
    name: 'two backslashes end value',
    includedPath: 'includes/team\\',
    value: 'includes/team\\\\\n# following comment',
    posixOnly: true
  },
  {
    name: 'four backslashes end value',
    includedPath: 'includes/team\\\\',
    value: 'includes/team\\\\\\\\\n# following comment',
    posixOnly: true
  },
  {
    name: 'escaped literal backslash then n',
    includedPath: 'includes/te\\nam.cfg',
    value: 'includes/te\\\\nam.cfg',
    posixOnly: true
  },
  {
    name: 'inline comment hash does not continue',
    includedPath: 'includes/team.cfg',
    value: 'includes/stable.cfg # ignored\\\n\tpath = includes/team.cfg',
    otherIncludedPaths: ['includes/stable.cfg'],
    expectedIncludedPaths: ['includes/stable.cfg', 'includes/team.cfg']
  },
  {
    name: 'full line comment hash does not continue',
    includedPath: 'includes/team.cfg',
    value: 'includes/stable.cfg\n# ignored\\\n\tpath = includes/team.cfg',
    otherIncludedPaths: ['includes/stable.cfg'],
    expectedIncludedPaths: ['includes/stable.cfg', 'includes/team.cfg']
  },
  {
    name: 'inline comment semicolon does not continue',
    includedPath: 'includes/team.cfg',
    value: 'includes/stable.cfg ; ignored\\\n\tpath = includes/team.cfg',
    otherIncludedPaths: ['includes/stable.cfg'],
    expectedIncludedPaths: ['includes/stable.cfg', 'includes/team.cfg']
  },
  {
    name: 'full line comment semicolon does not continue',
    includedPath: 'includes/team.cfg',
    value: 'includes/stable.cfg\n; ignored\\\n\tpath = includes/team.cfg',
    otherIncludedPaths: ['includes/stable.cfg'],
    expectedIncludedPaths: ['includes/stable.cfg', 'includes/team.cfg']
  },
  {
    name: 'continued quote then comment does not continue',
    includedPath: 'includes/team.cfg',
    value: '"includes/sta\\\nble.cfg"# ignored\\\n\tpath = includes/team.cfg',
    otherIncludedPaths: ['includes/stable.cfg'],
    expectedIncludedPaths: ['includes/stable.cfg', 'includes/team.cfg']
  },
  {
    name: 'continued quote first path',
    includedPath: 'includes/stable.cfg',
    value: '"includes/sta\\\nble.cfg"# ignored\\\n\tpath = includes/team.cfg',
    otherIncludedPaths: ['includes/team.cfg'],
    expectedIncludedPaths: ['includes/stable.cfg', 'includes/team.cfg']
  },
  {
    name: 'spaces before continuation then blank line',
    includedPath: 'includes/team.cfg  ',
    value: 'includes/team.cfg  \\\n\n# following comment',
    posixOnly: true
  },
  {
    name: 'continuation then blank line',
    includedPath: 'includes/team.cfg',
    value: 'includes/team.cfg\\\n\n# following comment'
  },
  {
    name: 'unquoted backslash at eof',
    includedPath: 'includes/team.cfg',
    value: 'includes/team.cfg\\',
    noFinalNewline: true
  },
  {
    name: 'leading value continuation skips indent',
    includedPath: 'includes/team.cfg',
    value: '\\\n\t  includes/team.cfg'
  },
  {
    name: 'empty quote leading continuation skips indent',
    includedPath: 'includes/team.cfg',
    value: '"" \t \\\n\tincludes/team.cfg'
  },
  {
    name: 'three backslashes in comment do not continue',
    includedPath: 'includes/team.cfg',
    value: 'includes/stable.cfg # ignored\\\\\\\n\tpath = includes/team.cfg',
    otherIncludedPaths: ['includes/stable.cfg'],
    expectedIncludedPaths: ['includes/stable.cfg', 'includes/team.cfg']
  },
  {
    name: 'escaped newline next to continuation',
    includedPath: 'includes/te\nam.cfg',
    value: '"includes/te\\n\\\nam.cfg"',
    posixOnly: true
  },
  {
    name: 'non path continuation must not change section',
    includedPath: 'includes/team.cfg',
    value: 'includes/stable.cfg\nignored = prefix\\\n[core]\npath = includes/team.cfg',
    otherIncludedPaths: ['includes/stable.cfg'],
    expectedIncludedPaths: ['includes/stable.cfg', 'includes/team.cfg']
  },
  ...[
    { name: 'attached section header', directivePrefix: '[include]path = ' },
    { name: 'indented mixed case header', directivePrefix: ' \t[InClUdE]\tPaTh = ' },
    {
      name: 'consecutive section headers',
      directivePrefix: '[include][core] [include] path = '
    },
    {
      name: 'escaped subsection quote before include',
      directivePrefix: '[remote "unused\\"tail"][include] path = '
    },
    {
      name: 'escaped subsection backslash before include',
      directivePrefix: '[remote "unused\\\\"][include] path = '
    },
    {
      name: 'other subsection escape before include',
      directivePrefix: '[remote "unused\\qtail"][include] path = '
    },
    {
      name: 'quoted subsection comment and bracket literals',
      directivePrefix: '[remote "unused#;]tail"][include] path = '
    },
    {
      name: 'include subsection before plain include',
      directivePrefix: '[include "unused"][include] path = '
    },
    { name: 'header chain before next line', directivePrefix: '[core][include]\npath = ' },
    {
      name: 'same line conditional header',
      directivePrefix: '[includeIf "gitdir:**/"] path = ',
      includeKey: 'includeif.gitdir:**/.path'
    },
    {
      name: 'conditional header after core with tab separator',
      directivePrefix: '[core][includeIf\t"gitdir:**/"] path = ',
      includeKey: 'includeif.gitdir:**/.path'
    },
    {
      name: 'same line unknown continued value preserves section',
      directivePrefix: '[include] ignored = prefix\\\n[core]\npath = '
    }
  ].map((testCase) => ({
    ...testCase,
    includedPath: 'includes/team.cfg',
    value: 'includes/team.cfg'
  })),
  {
    name: 'continued value after same line header',
    includedPath: 'includes/team.cfg',
    directivePrefix: '[include] path = ',
    value: '"includes/te\\\nam.cfg"# comment'
  }
]

describe.skipIf(Boolean(process.env.ORCA_GIT_COMPAT_IMAGE))(
  'included config values with real Git',
  () => {
    let root = ''
    let git: GitBinaryTestFixture

    beforeAll(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'orca-config-include-values-')))
      vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'missing-global-config'))
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
      if (process.env.ORCA_GIT_COMPAT_BINARY) {
        vi.stubEnv(
          'PATH',
          `${dirname(process.env.ORCA_GIT_COMPAT_BINARY)}${delimiter}${process.env.PATH ?? ''}`
        )
      }
      git = new GitBinaryTestFixture(root)
      await git.start()
      const version = (await git.exec(['--version'])).stdout.trim()
      expect((await gitExecFileAsync(['--version'], { cwd: root })).stdout.trim()).toBe(version)
      if (process.env.ORCA_GIT_COMPAT_VERSION) {
        expect(version).toBe(`git version ${process.env.ORCA_GIT_COMPAT_VERSION}`)
      }
    })

    beforeEach(() => {
      _resetRemoteNameListingCache()
      _resetOwnerRepoCache()
      __resetLocalGitConfigSignatureCacheForTests()
    })

    afterAll(async () => {
      _resetRemoteNameListingCache()
      _resetOwnerRepoCache()
      __resetLocalGitConfigSignatureCacheForTests()
      vi.unstubAllEnvs()
      await git?.stop()
      if (root) {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.each(cases.filter((testCase) => process.platform !== 'win32' || !testCase.posixOnly))(
      'refreshes signed remote caches after an include changes: $name',
      async ({
        includedPath,
        value,
        otherIncludedPaths,
        expectedIncludedPaths,
        noFinalNewline,
        directivePrefix,
        includeKey
      }) => {
        const repo = await mkdtemp(join(root, 'repo-'))
        await git.exec(['init', '-q', repo])
        for (const otherPath of otherIncludedPaths ?? []) {
          const stableConfig = join(repo, '.git', otherPath)
          await mkdir(dirname(stableConfig), { recursive: true })
          await writeFile(stableConfig, '# stable included config\n')
        }
        const includedConfig = join(repo, '.git', includedPath)
        await mkdir(dirname(includedConfig), { recursive: true })
        await writeFile(
          includedConfig,
          '[remote "origin"]\n\turl = https://github.com/before-org/origin-project.git\n'
        )
        const mainConfigPath = join(repo, '.git', 'config')
        await appendFile(
          mainConfigPath,
          `\n${directivePrefix ?? '[include]\n\tpath = '}${value}${noFinalNewline ? '' : '\n'}`
        )
        const mainConfig = await readFile(mainConfigPath)
        const head = await readFile(join(repo, '.git', 'HEAD'))
        expect(
          (
            await git.exec(['config', '--null', '--get-all', includeKey ?? 'include.path'], repo)
          ).stdout
            .slice(0, -1)
            .split('\0')
        ).toEqual(expectedIncludedPaths ?? [includedPath])

        const signature = await readLocalGitConfigSignature({ repoPath: repo })
        expect(signature).toBeDefined()
        expect(await listCachedRemoteNames(repo)).toEqual(['origin'])
        expect(await shouldProbeGitRemote(repo, 'upstream')).toBe(false)
        expect(await getOwnerRepoForRemote(repo, 'upstream')).toBeNull()
        expect(await getOwnerRepo(repo)).toEqual({ owner: 'before-org', repo: 'origin-project' })

        await appendFile(
          includedConfig,
          '\n[remote "upstream"]\n\turl = https://github.com/upstream-org/shared-project.git\n'
        )
        expect((await git.exec(['remote'], repo)).stdout.trim().split('\n')).toEqual([
          'origin',
          'upstream'
        ])
        expect(await listCachedRemoteNames(repo)).toEqual(['origin', 'upstream'])
        expect(await shouldProbeGitRemote(repo, 'upstream')).toBe(true)
        expect(await getOwnerRepoForRemote(repo, 'upstream')).toEqual({
          owner: 'upstream-org',
          repo: 'shared-project'
        })
        expect(await getOwnerRepo(repo)).toEqual({
          owner: 'upstream-org',
          repo: 'shared-project'
        })
        expect(await getOwnerRepoForRemote(repo, 'origin')).toEqual({
          owner: 'before-org',
          repo: 'origin-project'
        })
        expect(await readLocalGitConfigSignature({ repoPath: repo })).not.toBe(signature)

        const appended = await readFile(includedConfig, 'utf8')
        await writeFile(
          includedConfig,
          appended.replace('before-org/origin-project', 'after-org/replaced-origin-project')
        )
        expect((await git.exec(['remote', 'get-url', 'origin'], repo)).stdout.trim()).toBe(
          'https://github.com/after-org/replaced-origin-project.git'
        )
        expect(await getOwnerRepoForRemote(repo, 'origin')).toEqual({
          owner: 'after-org',
          repo: 'replaced-origin-project'
        })
        expect(await readFile(mainConfigPath)).toEqual(mainConfig)
        expect(await readFile(join(repo, '.git', 'HEAD'))).toEqual(head)
      }
    )

    it.each([
      { name: 'include subsection', configText: '[include "unused"]path = includes/team.cfg' },
      { name: 'last noninclude header', configText: '[include][core]path = includes/team.cfg' },
      {
        name: 'continued core value consumes include header',
        configText: '[core] ignored = prefix\\\n[include]\npath = includes/team.cfg'
      },
      {
        name: 'comment after header',
        configText: '[include]# comment [include]path = includes/team.cfg'
      },
      {
        name: 'invalid whitespace before bracket',
        configText: '[include ]path = includes/team.cfg',
        invalid: true
      },
      {
        name: 'invalid single quoted subsection',
        configText: "[includeIf 'gitdir:**/']path = includes/team.cfg",
        invalid: true
      },
      {
        name: 'invalid escaped closing quote',
        configText: '[remote "unused\\"][include]path = includes/team.cfg',
        invalid: true
      }
    ])(
      'does not track paths outside valid include assignments: $name',
      async ({ configText, invalid }) => {
        const repo = await mkdtemp(join(root, 'repo-'))
        await git.exec(['init', '-q', repo])
        const includedConfig = join(repo, '.git', 'includes', 'team.cfg')
        await mkdir(dirname(includedConfig), { recursive: true })
        await writeFile(
          includedConfig,
          '[remote "origin"]\nurl = https://github.com/org/project.git\n'
        )
        const mainConfigPath = join(repo, '.git', 'config')
        await appendFile(mainConfigPath, `\n${configText}\n`)
        const mainConfig = await readFile(mainConfigPath)
        const head = await readFile(join(repo, '.git', 'HEAD'))
        if (invalid) {
          await expect(git.exec(['remote'], repo)).rejects.toMatchObject({ code: 128 })
        } else {
          expect((await git.exec(['remote'], repo)).stdout.trim()).toBe('')
        }
        const signature = await readLocalGitConfigSignature({ repoPath: repo })
        expect(signature).toBeDefined()

        await appendFile(includedConfig, '\n# unrelated file change\n')

        expect(await readLocalGitConfigSignature({ repoPath: repo })).toBe(signature)
        expect(await readFile(mainConfigPath)).toEqual(mainConfig)
        expect(await readFile(join(repo, '.git', 'HEAD'))).toEqual(head)
      }
    )
  }
)
