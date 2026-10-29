import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import { scanGitConfigAssignments } from '../git/git-config-assignments'
import type { GitHubRepoContext } from './github-repository-identity'
import { CONFIG_SIGNATURE_DEADLINE_MS, readLocalGitConfigScan } from './local-git-config-scan'
import type { IncludedGitConfigPath, LocalGitConfigNode } from './local-git-config-traversal'

const localGitConfigSignatureInFlight: CoalescedProbes<string | undefined> = new Map()

export async function readLocalGitConfigSignature(
  context: GitHubRepoContext
): Promise<string | undefined> {
  if (context.connectionId || context.wslDistro) {
    // Remote runtimes have separate cache keys; this signature covers host filesystem config only.
    return undefined
  }
  // Keep timed-out reads shared while their started filesystem work settles.
  return withConfigSignatureDeadline(
    runCoalescedProbe(localGitConfigSignatureInFlight, context.repoPath, () =>
      readLocalGitConfigScan(context, readLocalGitConfigNode)
    )
  )
}

function withConfigSignatureDeadline(
  read: Promise<string | undefined>
): Promise<string | undefined> {
  return new Promise((settle) => {
    const timer = setTimeout(() => settle(undefined), CONFIG_SIGNATURE_DEADLINE_MS)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
    void read.then(
      (signature) => {
        clearTimeout(timer)
        settle(signature)
      },
      () => {
        clearTimeout(timer)
        settle(undefined)
      }
    )
  })
}

export function __resetLocalGitConfigSignatureCacheForTests(): void {
  localGitConfigSignatureInFlight.clear()
}

async function readLocalGitConfigNode(
  configPath: string,
  isActive: () => boolean = () => true
): Promise<LocalGitConfigNode> {
  const signature = await readConfigPathSignature(configPath)
  if (!isActive()) {
    return { signature, includedPaths: [], hasConditionalIncludes: false }
  }
  try {
    const configText = await readFile(configPath, 'utf8')
    return isActive()
      ? { signature, ...parseIncludedConfigPaths(configText, dirname(configPath)) }
      : { signature, includedPaths: [], hasConditionalIncludes: false }
  } catch {
    return { signature, includedPaths: [], hasConditionalIncludes: false }
  }
}

async function readConfigPathSignature(configPath: string): Promise<string> {
  try {
    const stats = await stat(configPath)
    return `${configPath}\0${stats.mtimeMs}\0${stats.size}`
  } catch {
    return `${configPath}\0missing`
  }
}

function parseIncludedConfigPaths(
  configText: string,
  baseDir: string
): { includedPaths: IncludedGitConfigPath[]; hasConditionalIncludes: boolean } {
  const includedPaths: IncludedGitConfigPath[] = []
  let hasConditionalIncludes = false
  for (const assignment of scanGitConfigAssignments(configText)) {
    const section = assignment.section
    if (
      !section ||
      !(
        (section.name === 'include' && !section.hasSubsection) ||
        (section.name === 'includeif' && section.hasSubsection)
      ) ||
      assignment.key !== 'path' ||
      assignment.value.kind !== 'explicit' ||
      !assignment.value.decoded
    ) {
      continue
    }
    const value = assignment.value.decoded
    hasConditionalIncludes ||= section.name === 'includeif' && section.hasSubsection
    const current = resolveIncludedConfigPath(value.value, baseDir)
    const legacy =
      value.legacyValue === undefined
        ? undefined
        : resolveIncludedConfigPath(value.legacyValue, baseDir)
    includedPaths.push(
      legacy !== undefined && legacy !== current ? { current, legacy } : { current }
    )
  }
  return { includedPaths, hasConditionalIncludes }
}

function resolveIncludedConfigPath(includePath: string, baseDir: string): string {
  if (includePath === '~') {
    return homedir()
  }
  if (includePath.startsWith('~/')) {
    return join(homedir(), includePath.slice(2))
  }
  if (isAbsolute(includePath)) {
    return includePath
  }
  return resolve(baseDir, includePath)
}
