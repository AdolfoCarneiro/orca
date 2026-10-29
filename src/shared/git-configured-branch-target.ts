import { gitRefTargetsBranchOnRemote } from './git-remote-branch-name'
import {
  findGitRemoteNameByFetchUrl,
  findUniqueGitRemoteNameByFetchUrl
} from './git-remote-url-index'
import { sourceRefsForTarget } from './git-branch-cleanup-fetch'
import {
  createGitConfigSnapshotRunner,
  GitConfigSnapshotKeyNotFoundError
} from './git-config-snapshot-runner'
import { isExecKilledError } from './git-remote-error'
import { isSafeGitRefName } from './git-status-upstream-ref'

type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

type RemoteTrackingRefExists = (remoteName: string, branchName: string) => Promise<boolean>

export type ConfiguredBranchRemoteUpstreamOptions = {
  urlRecovery?: boolean
}

export type ConfiguredBranchRemoteUpstream = {
  upstreamName: string
  remoteName: string
  branchName: string
  isConfiguredUpstream: false
}

async function getGitConfigValue(
  runGit: GitCommandRunner,
  key: string,
  propagateReadErrors = false
): Promise<string | null> {
  try {
    const { stdout } = await runGit(['config', '--get', key])
    const value = stdout.trim()
    return value || null
  } catch (error) {
    if (propagateReadErrors && !(error instanceof GitConfigSnapshotKeyNotFoundError)) {
      throw error
    }
    return null
  }
}

async function readRawGitConfigValues(
  runGit: GitCommandRunner,
  key: string
): Promise<string[] | null> {
  try {
    const { stdout } = await runGit(['config', '--null', '--get-all', key])
    return stdout.endsWith('\0') ? stdout.slice(0, -1).split('\0') : null
  } catch (error) {
    if (error instanceof GitConfigSnapshotKeyNotFoundError) {
      return null
    }
    throw error
  }
}

function isUrlValuedRemote(remote: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote) || /^[^@/:]+@[^:]+:.+/.test(remote)
}

// Two URL-valued remotes formerly cost up to 2 × (1 + remotes) subprocesses.
async function findRemoteNameForUrl(
  runGit: GitCommandRunner,
  remoteUrl: string,
  propagateReadErrors = false
): Promise<string | null> {
  try {
    const { stdout } = await runGit(['remote', '-v'])
    const findRemote = propagateReadErrors
      ? findUniqueGitRemoteNameByFetchUrl
      : findGitRemoteNameByFetchUrl
    const remoteName = findRemote(stdout, (candidateUrl) => candidateUrl === remoteUrl)
    if (propagateReadErrors && remoteName) {
      const rawUrls = await readRawGitConfigValues(runGit, `remote.${remoteName}.url`)
      return rawUrls?.[0] === remoteUrl ? remoteName : null
    }
    return remoteName
  } catch (error) {
    if (propagateReadErrors) {
      throw error
    }
    return null
  }
}

async function remoteFetchMapsBranchToStandardRef(
  runGit: GitCommandRunner,
  remoteName: string,
  branchName: string
): Promise<boolean> {
  const target = `refs/remotes/${remoteName}/${branchName}`
  if (!isSafeGitRefName(target)) {
    return false
  }
  let stdout: string
  try {
    ;({ stdout } = await runGit(['config', '--get-all', `remote.${remoteName}.fetch`]))
  } catch (error) {
    if (error instanceof GitConfigSnapshotKeyNotFoundError) {
      return false
    }
    throw error
  }
  const refspecs = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (refspecs.filter((refspec) => !refspec.startsWith('^')).length !== 1) {
    return false
  }
  const sources = sourceRefsForTarget(refspecs, target)
  return sources.length === 1 && sources[0] === `refs/heads/${branchName}`
}

export async function getConfiguredBranchRemoteUpstream(
  runGit: GitCommandRunner,
  currentBranchName: string,
  remoteTrackingRefExists: RemoteTrackingRefExists,
  options: ConfiguredBranchRemoteUpstreamOptions = {}
): Promise<ConfiguredBranchRemoteUpstream | null> {
  const [remote, mergeRef, baseRef] = await Promise.all([
    getGitConfigValue(runGit, `branch.${currentBranchName}.remote`, options.urlRecovery),
    getGitConfigValue(runGit, `branch.${currentBranchName}.merge`, options.urlRecovery),
    getGitConfigValue(runGit, `branch.${currentBranchName}.base`, options.urlRecovery)
  ])
  const branchName = mergeRef?.replace(/^refs\/heads\//, '') ?? ''
  if (
    !remote ||
    !branchName ||
    branchName === mergeRef ||
    remote === '.' ||
    (options.urlRecovery && !isUrlValuedRemote(remote))
  ) {
    return null
  }

  const remoteName = isUrlValuedRemote(remote)
    ? await findRemoteNameForUrl(runGit, remote, options.urlRecovery)
    : remote
  if (
    !remoteName ||
    (options.urlRecovery && remoteName.startsWith('-')) ||
    gitRefTargetsBranchOnRemote(baseRef, remoteName, branchName) ||
    (options.urlRecovery &&
      !(await remoteFetchMapsBranchToStandardRef(runGit, remoteName, branchName))) ||
    !(await remoteTrackingRefExists(remoteName, branchName))
  ) {
    return null
  }
  return {
    upstreamName: `${remoteName}/${branchName}`,
    remoteName,
    branchName,
    isConfiguredUpstream: false
  }
}

export async function readRemoteTrackingUpstreamName(
  runGit: GitCommandRunner,
  remoteName: string,
  branchName: string,
  propagateReadErrors = false
): Promise<string | null> {
  const remoteRef = `refs/remotes/${remoteName}/${branchName}`
  if (!isSafeGitRefName(remoteRef)) {
    return null
  }
  try {
    const { stdout } = await runGit([
      'for-each-ref',
      '--format=%(refname)%00',
      '--count=1',
      remoteRef
    ])
    return stdout.replace(/\r?\n$/, '') === `${remoteRef}\0` ? remoteRef : null
  } catch (error) {
    if (propagateReadErrors) {
      throw error
    }
    return null
  }
}

export async function resolveConfiguredBranchRemoteTrackingUpstream(
  runGit: GitCommandRunner,
  currentBranchName: string,
  options: ConfiguredBranchRemoteUpstreamOptions = {}
): Promise<{ upstream: ConfiguredBranchRemoteUpstream; comparisonRef?: string } | null> {
  let comparisonRef: string | null = null
  const upstream = await getConfiguredBranchRemoteUpstream(
    runGit,
    currentBranchName,
    async (remoteName, branchName) => {
      comparisonRef = await readRemoteTrackingUpstreamName(
        runGit,
        remoteName,
        branchName,
        options.urlRecovery
      )
      return comparisonRef !== null
    },
    options
  )
  return upstream ? { upstream, comparisonRef: comparisonRef ?? undefined } : null
}

function isUnstoredConfiguredUpstreamError(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    isExecKilledError(error) ||
    error.name === 'AbortError' ||
    ('code' in error && error.code !== undefined && error.code !== 128)
  ) {
    return false
  }
  return /(^|\r?\n)fatal: upstream branch '[^'\r\n]+' not stored as a remote-tracking branch(?:\r?\n|$)/.test(
    error.message
  )
}

export async function recoverUrlValuedConfiguredUpstream(
  execGit: GitCommandRunner,
  currentBranchName: string | null,
  error: unknown
): Promise<{ upstream: ConfiguredBranchRemoteUpstream; comparisonRef?: string } | null> {
  if (!currentBranchName || !isUnstoredConfiguredUpstreamError(error)) {
    throw error
  }
  const runGit = createGitConfigSnapshotRunner(execGit, {
    propagateReadErrors: true,
    includeAllValues: true
  })
  const [mergeValues, remoteValues] = await Promise.all([
    readRawGitConfigValues(runGit, `branch.${currentBranchName}.merge`),
    readRawGitConfigValues(runGit, `branch.${currentBranchName}.remote`)
  ])
  const remote = remoteValues?.at(-1)
  if (
    mergeValues?.length !== 1 ||
    !mergeValues[0].startsWith('refs/heads/') ||
    !isSafeGitRefName(mergeValues[0]) ||
    !remote ||
    remote.trim() !== remote
  ) {
    throw error
  }
  const recovered = await resolveConfiguredBranchRemoteTrackingUpstream(runGit, currentBranchName, {
    urlRecovery: true
  })
  if (!recovered) {
    throw error
  }
  return recovered
}

export async function hasConfiguredBranchPushTarget(
  runGit: GitCommandRunner,
  currentBranchName: string
): Promise<boolean> {
  const [pushRemote, pushDefault, branchRemote, mergeRef, baseRef] = await Promise.all([
    getGitConfigValue(runGit, `branch.${currentBranchName}.pushRemote`),
    getGitConfigValue(runGit, 'remote.pushDefault'),
    getGitConfigValue(runGit, `branch.${currentBranchName}.remote`),
    getGitConfigValue(runGit, `branch.${currentBranchName}.merge`),
    getGitConfigValue(runGit, `branch.${currentBranchName}.base`)
  ])
  const remote = pushRemote ?? pushDefault ?? branchRemote
  const branchName = mergeRef?.replace(/^refs\/heads\//, '') ?? ''
  if (!remote || remote === '.' || !branchName || branchName === mergeRef) {
    return false
  }
  const pushRemoteName = isUrlValuedRemote(remote)
    ? ((await findRemoteNameForUrl(runGit, remote)) ?? remote)
    : remote
  // The two usually name the same URL; resolving it twice reads the remote table twice.
  const branchRemoteName = !branchRemote
    ? null
    : branchRemote === remote
      ? pushRemoteName
      : isUrlValuedRemote(branchRemote)
        ? ((await findRemoteNameForUrl(runGit, branchRemote)) ?? branchRemote)
        : branchRemote
  if (gitRefTargetsBranchOnRemote(baseRef, pushRemoteName, branchName)) {
    return false
  }
  // branch.merge belongs to branch.remote; pushDefault forks cannot borrow origin/main to become pushable.
  if (
    branchName !== currentBranchName &&
    (pushRemoteName === 'origin' || branchRemoteName !== pushRemoteName)
  ) {
    return false
  }
  return true
}
