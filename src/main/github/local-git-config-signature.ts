import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import type { GitHubRepoContext } from './github-repository-identity'

type LocalGitConfigPaths = {
  commonConfigPath: string
  worktreeConfigPath: string
}

// A dead mount can stall stat before the bounded Git probe; missing signatures use shorter cache lifetimes.
const CONFIG_SIGNATURE_DEADLINE_MS = 2_000

const localGitConfigSignatureInFlight: CoalescedProbes<string | undefined> = new Map()

export async function readLocalGitConfigSignature(
  context: GitHubRepoContext
): Promise<string | undefined> {
  if (context.connectionId || context.wslDistro) {
    // Remote runtimes have separate cache keys; this signature covers host filesystem config only.
    return undefined
  }
  // Deadline only the caller: keep the in-flight read shared so a hung mount cannot accumulate more reads.
  return withConfigSignatureDeadline(
    runCoalescedProbe(localGitConfigSignatureInFlight, context.repoPath, () =>
      readUncachedLocalGitConfigSignature(context.repoPath)
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

async function readUncachedLocalGitConfigSignature(repoPath: string): Promise<string | undefined> {
  const configPaths = await resolveLocalGitConfigPaths(repoPath)
  if (!configPaths) {
    return undefined
  }
  const signatures = await Promise.all([
    readConfigPathSignatures(configPaths.commonConfigPath),
    readConfigPathSignatures(configPaths.worktreeConfigPath)
  ])
  return signatures.flat().join('\0')
}

async function readConfigPathSignatures(
  configPath: string,
  visited = new Set<string>()
): Promise<string[]> {
  if (visited.has(configPath)) {
    return []
  }
  visited.add(configPath)

  const ownSignature = await readConfigPathSignature(configPath)
  let configText: string
  try {
    configText = await readFile(configPath, 'utf8')
  } catch {
    return [ownSignature]
  }

  const includedPaths = parseIncludedConfigPaths(configText, dirname(configPath))
  const includedSignatures = await Promise.all(
    includedPaths.map((includedPath) => readConfigPathSignatures(includedPath, visited))
  )
  return [ownSignature, ...includedSignatures.flat()]
}

async function readConfigPathSignature(configPath: string): Promise<string> {
  try {
    const stats = await stat(configPath)
    return `${configPath}\0${stats.mtimeMs}\0${stats.size}`
  } catch {
    return `${configPath}\0missing`
  }
}

function parseIncludedConfigPaths(configText: string, baseDir: string): string[] {
  const includedPaths: string[] = []
  let inIncludeSection = false
  const lines = configText.split(/\r?\n/).values()
  for (const rawLine of lines) {
    const line = rawLine.trimStart()
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue
    }
    let offset = 0
    for (
      let section = parseConfigSectionHeader(line, offset);
      section;
      section = parseConfigSectionHeader(line, offset)
    ) {
      inIncludeSection =
        (section.name === 'include' && !section.hasSubsection) ||
        (section.name === 'includeif' && section.hasSubsection)
      offset = section.end
      while (line[offset] === ' ' || line[offset] === '\t') {
        offset += 1
      }
    }
    const assignment = line.slice(offset).match(/^([a-z][a-z0-9-]*)\s*=\s*(.*)$/i)
    if (!assignment) {
      continue
    }
    const value = parseConfigValue(assignment[2], lines)
    if (inIncludeSection && assignment[1].toLowerCase() === 'path' && value) {
      includedPaths.push(resolveIncludedConfigPath(value, baseDir))
    }
  }
  return includedPaths
}

function parseConfigSectionHeader(
  line: string,
  offset: number
): { name: string; hasSubsection: boolean; end: number } | null {
  if (line[offset] !== '[') {
    return null
  }
  const nameStart = offset + 1
  let index = nameStart
  while (index < line.length && /[a-z0-9.-]/i.test(line[index])) {
    index += 1
  }
  if (index === nameStart) {
    return null
  }
  const name = line.slice(nameStart, index).toLowerCase()
  let hasSubsection = false
  if (line[index] === ' ' || line[index] === '\t') {
    while (line[index] === ' ' || line[index] === '\t') {
      index += 1
    }
    if (line[index] !== '"') {
      return null
    }
    hasSubsection = true
    for (index += 1; index < line.length; index += 1) {
      const char = line[index]
      if (char === '\\') {
        index += 1
      } else if (char === '"') {
        index += 1
        break
      }
    }
  }
  if (line[index] !== ']') {
    return null
  }
  return { name, hasSubsection, end: index + 1 }
}

function parseConfigValue(firstLine: string, lines: Iterator<string>): string | null {
  let rawValue = firstLine
  let value = ''
  let quoted = false
  let trailingWhitespace: number | null = null
  for (let index = 0; index < rawValue.length; index += 1) {
    const char = rawValue[index]
    if (char === '\\') {
      index += 1
      if (index === rawValue.length) {
        trailingWhitespace = null
        const continuation = lines.next()
        if (continuation.done) {
          break
        }
        rawValue = continuation.value
        index = -1
        continue
      }
      const escaped = rawValue[index]
      switch (escaped) {
        case '\\':
        case '"':
          value += escaped
          break
        case 't':
          value += '\t'
          break
        case 'n':
          value += '\n'
          break
        case 'b':
          value += '\b'
          break
        default:
          return null
      }
      trailingWhitespace = null
      continue
    }
    if (char === '"') {
      quoted = !quoted
      trailingWhitespace = null
      continue
    }
    if (!quoted && (char === '#' || char === ';')) {
      break
    }
    if (!quoted && /[ \t\r\v\f]/.test(char)) {
      if (!value) {
        continue
      }
      trailingWhitespace ??= value.length
    } else {
      trailingWhitespace = null
    }
    value += char
  }
  if (quoted) {
    return null
  }
  return (trailingWhitespace === null ? value : value.slice(0, trailingWhitespace)) || null
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

async function resolveLocalGitConfigPaths(repoPath: string): Promise<LocalGitConfigPaths | null> {
  const dotGitPath = join(repoPath, '.git')
  try {
    const dotGitStats = await stat(dotGitPath)
    if (dotGitStats.isDirectory()) {
      return {
        commonConfigPath: join(dotGitPath, 'config'),
        worktreeConfigPath: join(dotGitPath, 'config.worktree')
      }
    }
    if (!dotGitStats.isFile()) {
      return null
    }
  } catch {
    return null
  }

  try {
    const gitFile = await readFile(dotGitPath, 'utf8')
    const match = gitFile.match(/^gitdir:\s*(.+?)\s*$/im)
    if (!match) {
      return null
    }
    const gitDir = resolve(dirname(dotGitPath), match[1])
    let commonGitDir = gitDir
    try {
      const commonDir = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
      if (commonDir) {
        commonGitDir = resolve(gitDir, commonDir)
      }
    } catch {
      // Try the linked-worktree gitdir instead.
    }
    return {
      commonConfigPath: join(commonGitDir, 'config'),
      worktreeConfigPath: join(gitDir, 'config.worktree')
    }
  } catch {
    return null
  }
}
