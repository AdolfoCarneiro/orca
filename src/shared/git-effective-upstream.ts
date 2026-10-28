import { isNoUpstreamError } from './git-remote-error'
import { isSafeGitRefName } from './git-status-upstream-ref'
import type { GitUpstreamStatus } from './git-status-types'
import {
  getConfiguredBranchRemoteUpstream,
  hasConfiguredBranchPushTarget
} from './git-configured-branch-target'
import { splitRemoteBranchName } from './git-remote-branch-name'
import { parseGitRevListAheadBehindCounts } from './git-rev-list-output'
import { iterateProcessOutputLines } from './process-output-field-scanner'
import { createGitConfigSnapshotRunner } from './git-config-snapshot-runner'
import { getGitCurrentBranchName } from './git-current-branch'

export { gitRefTargetsBranchName, splitRemoteBranchName } from './git-remote-branch-name'

export type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

export type EffectiveGitUpstream =
  | {
      upstreamName: string
      remoteName: string | null
      branchName: string
      isConfiguredUpstream: true
    }
  | {
      upstreamName: string
      remoteName: string
      branchName: string
      isConfiguredUpstream: false
    }

function hasMultipleSlashSegments(refName: string): boolean {
  return refName.includes('/') && refName.indexOf('/') !== refName.lastIndexOf('/')
}

async function splitRemoteBranchNameByKnownRemote(
  runGit: GitCommandRunner,
  refName: string
): Promise<{ remoteName: string; branchName: string } | null> {
  try {
    const { stdout } = await runGit(['remote'])
    let bestRemoteName: string | null = null
    for (const rawLine of iterateProcessOutputLines(stdout)) {
      const remoteName = rawLine.trim()
      // Why: preserve longest-remote matching for remote names that contain slashes.
      if (
        !remoteName ||
        refName === remoteName ||
        !refName.startsWith(`${remoteName}/`) ||
        (bestRemoteName && bestRemoteName.length >= remoteName.length)
      ) {
        continue
      }
      bestRemoteName = remoteName
    }
    if (!bestRemoteName) {
      return null
    }
    const branchName = refName.slice(bestRemoteName.length + 1)
    return branchName ? { remoteName: bestRemoteName, branchName } : null
  } catch {
    return null
  }
}

async function getConfiguredUpstream(
  runGit: GitCommandRunner,
  currentBranchName: string | null
): Promise<{ upstream: EffectiveGitUpstream; canUseSameNameOriginFallback: boolean } | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD@{u}'])
    const upstreamName = stdout.trim()
    if (
      currentBranchName &&
      (!upstreamName || /^(?:refs\/|heads\/|remotes\/)/.test(upstreamName))
    ) {
      const branchRef = `refs/heads/${currentBranchName}`
      const metadata = await runGit([
        'for-each-ref',
        '--format=%(refname)%00%(upstream)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)',
        '--count=1',
        branchRef
      ])
      const fields = metadata.stdout.replace(/\r?\n$/, '').split('\0')
      if (
        fields.length !== 5 ||
        fields[0] !== branchRef ||
        (upstreamName && fields[2] !== upstreamName)
      ) {
        throw new Error('Unable to resolve qualified configured upstream')
      }
      if (!fields[1]) {
        return null
      }
      if (!isSafeGitRefName(fields[1]) || !isSafeGitRefName(fields[4])) {
        throw new Error('Unable to resolve qualified configured upstream')
      }
      return {
        upstream: {
          upstreamName: upstreamName || fields[1],
          remoteName: fields[3] && fields[3] !== '.' ? fields[3] : null,
          branchName: fields[4].replace(/^refs\/heads\//, ''),
          isConfiguredUpstream: true
        },
        canUseSameNameOriginFallback: fields[4].startsWith('refs/heads/')
      }
    }
    if (!upstreamName) {
      return null
    }
    const parsed = splitRemoteBranchName(upstreamName)
    if (!parsed) {
      return {
        upstream: {
          upstreamName,
          remoteName: null,
          branchName: upstreamName,
          isConfiguredUpstream: true
        },
        canUseSameNameOriginFallback: true
      }
    }
    return {
      upstream: {
        upstreamName,
        remoteName: parsed.remoteName,
        branchName: parsed.branchName,
        isConfiguredUpstream: true
      },
      canUseSameNameOriginFallback: true
    }
  } catch (error) {
    if (isNoUpstreamError(error)) {
      return null
    }
    throw error
  }
}

async function remoteTrackingRefExists(
  runGit: GitCommandRunner,
  remoteName: string,
  branchName: string
): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteName}/${branchName}`])
    return true
  } catch {
    return false
  }
}

async function resolveEffectiveGitUpstreamForBranch(
  runGit: GitCommandRunner,
  currentBranchName: string | null
): Promise<EffectiveGitUpstream | null> {
  const configuredTarget = await getConfiguredUpstream(runGit, currentBranchName)
  let configured = configuredTarget?.upstream

  if (configured) {
    if (
      currentBranchName &&
      configured.remoteName === 'origin' &&
      configured.upstreamName.startsWith('origin/') &&
      configured.branchName !== currentBranchName &&
      hasMultipleSlashSegments(configured.upstreamName)
    ) {
      const parsed = await splitRemoteBranchNameByKnownRemote(runGit, configured.upstreamName)
      if (parsed) {
        configured = { ...configured, ...parsed }
      }
    }

    if (!currentBranchName || configured.branchName === currentBranchName) {
      return configured
    }

    // Legacy worktrees tracked origin/main while publishing same-name branches; pull/sync must follow the existing publish branch.
    if (
      configuredTarget?.canUseSameNameOriginFallback &&
      configured.remoteName === 'origin' &&
      (await remoteTrackingRefExists(runGit, configured.remoteName, currentBranchName))
    ) {
      return {
        upstreamName: `${configured.remoteName}/${currentBranchName}`,
        remoteName: configured.remoteName,
        branchName: currentBranchName,
        isConfiguredUpstream: false
      }
    }

    return configured
  }

  if (currentBranchName) {
    const branchRemoteUpstream = await getConfiguredBranchRemoteUpstream(
      runGit,
      currentBranchName,
      (remoteName, branchName) => remoteTrackingRefExists(runGit, remoteName, branchName)
    )
    if (branchRemoteUpstream) {
      // URL-valued branch.remote breaks HEAD@{u}; legacy fork-review worktrees can still supply a usable merge target.
      return branchRemoteUpstream
    }
  }

  if (currentBranchName && (await remoteTrackingRefExists(runGit, 'origin', currentBranchName))) {
    return {
      upstreamName: `origin/${currentBranchName}`,
      remoteName: 'origin',
      branchName: currentBranchName,
      isConfiguredUpstream: false
    }
  }

  return null
}

export async function resolveEffectiveGitUpstream(
  execGit: GitCommandRunner
): Promise<EffectiveGitUpstream | null> {
  const runGit = createGitConfigSnapshotRunner(execGit)
  return resolveEffectiveGitUpstreamForBranch(runGit, await getGitCurrentBranchName(runGit))
}

export async function getEffectiveGitUpstreamStatus(
  execGit: GitCommandRunner,
  getBehindCommitsArePatchEquivalent?: (upstreamName: string) => Promise<boolean>
): Promise<GitUpstreamStatus> {
  const runGit = createGitConfigSnapshotRunner(execGit)
  const currentBranchName = await getGitCurrentBranchName(runGit)
  const upstream = await resolveEffectiveGitUpstreamForBranch(runGit, currentBranchName)
  if (!upstream) {
    const hasConfiguredPushTarget = currentBranchName
      ? await hasConfiguredBranchPushTarget(runGit, currentBranchName)
      : false
    return {
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      ...(hasConfiguredPushTarget ? { hasConfiguredPushTarget: true } : {})
    }
  }

  return getGitUpstreamStatusForUpstreamName(
    runGit,
    upstream.upstreamName,
    getBehindCommitsArePatchEquivalent
  )
}

/** Refresh ahead/behind with one rev-list when branch/config-derived upstream resolution is already cached. */
export async function getGitUpstreamStatusForUpstreamName(
  runGit: GitCommandRunner,
  upstreamName: string,
  getBehindCommitsArePatchEquivalent?: (upstreamName: string) => Promise<boolean>
): Promise<GitUpstreamStatus> {
  const { stdout } = await runGit(['rev-list', '--left-right', '--count', `HEAD...${upstreamName}`])
  const counts = parseGitRevListAheadBehindCounts(stdout)
  if (counts.status === 'unexpected-field-count') {
    throw new Error(`Unexpected git rev-list output: ${JSON.stringify(stdout)}`)
  }
  if (counts.status === 'unparseable-counts') {
    throw new Error(`Unparseable git rev-list counts: ${JSON.stringify(stdout)}`)
  }

  const behindCommitsArePatchEquivalent =
    counts.ahead > 0 && counts.behind > 0 && getBehindCommitsArePatchEquivalent
      ? await getBehindCommitsArePatchEquivalent(upstreamName)
      : undefined

  return {
    hasUpstream: true,
    upstreamName,
    ahead: counts.ahead,
    behind: counts.behind,
    ...(behindCommitsArePatchEquivalent !== undefined ? { behindCommitsArePatchEquivalent } : {})
  }
}
