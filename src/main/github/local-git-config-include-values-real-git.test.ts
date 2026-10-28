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
}

const cases: IncludePathCase[] = [
  { name: 'unquoted', includedPath: 'includes/team.cfg', value: 'includes/team.cfg' },
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
      async ({ includedPath, value }) => {
        const repo = await mkdtemp(join(root, 'repo-'))
        await git.exec(['init', '-q', repo])
        const includedConfig = join(repo, '.git', includedPath)
        await mkdir(dirname(includedConfig), { recursive: true })
        await writeFile(
          includedConfig,
          '[remote "origin"]\n\turl = https://github.com/before-org/origin-project.git\n'
        )
        const mainConfigPath = join(repo, '.git', 'config')
        await appendFile(mainConfigPath, `\n[include]\n\tpath = ${value}\n`)
        const mainConfig = await readFile(mainConfigPath)
        const head = await readFile(join(repo, '.git', 'HEAD'))
        expect(
          (await git.exec(['config', '--get', 'include.path'], repo)).stdout.slice(0, -1)
        ).toBe(includedPath)

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
  }
)
