import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import type { GitHubRepoContext } from './github-repository-identity'
import { resolveLocalGitConfigPaths } from './local-git-config-paths'

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
  return signatures.flat().sort().join('\0')
}

const LITERAL_CONFIG_PATH_MODE = 1
const LEGACY_CONFIG_PATH_MODE = 2
const ALL_CONFIG_PATH_MODES = LITERAL_CONFIG_PATH_MODE | LEGACY_CONFIG_PATH_MODE

type IncludedGitConfigPath = { current: string; legacy?: string }
type LocalGitConfigNode = { signature: string; includedPaths: IncludedGitConfigPath[] }

async function readConfigPathSignatures(
  configPath: string,
  visited = new Map<string, number>(),
  modes = ALL_CONFIG_PATH_MODES,
  reads = new Map<string, Promise<LocalGitConfigNode>>()
): Promise<string[]> {
  const previousModes = visited.get(configPath) ?? 0
  const remainingModes = modes & ~previousModes
  if (!remainingModes) {
    return []
  }
  visited.set(configPath, previousModes | remainingModes)
  let pending = reads.get(configPath)
  if (!pending) {
    pending = readLocalGitConfigNode(configPath)
    reads.set(configPath, pending)
  }
  const node = await pending
  const included: Promise<string[]>[] = []
  for (const path of node.includedPaths) {
    if (path.legacy === undefined) {
      included.push(readConfigPathSignatures(path.current, visited, remainingModes, reads))
    } else {
      if (remainingModes & LITERAL_CONFIG_PATH_MODE) {
        included.push(
          readConfigPathSignatures(path.current, visited, LITERAL_CONFIG_PATH_MODE, reads)
        )
      }
      if (remainingModes & LEGACY_CONFIG_PATH_MODE) {
        included.push(
          readConfigPathSignatures(path.legacy, visited, LEGACY_CONFIG_PATH_MODE, reads)
        )
      }
    }
  }
  const signatures = (await Promise.all(included)).flat()
  return previousModes === 0 ? [node.signature, ...signatures] : signatures
}

async function readLocalGitConfigNode(configPath: string): Promise<LocalGitConfigNode> {
  const signature = await readConfigPathSignature(configPath)
  try {
    const configText = await readFile(configPath, 'utf8')
    return { signature, includedPaths: parseIncludedConfigPaths(configText, dirname(configPath)) }
  } catch {
    return { signature, includedPaths: [] }
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

function parseIncludedConfigPaths(configText: string, baseDir: string): IncludedGitConfigPath[] {
  const includedPaths: IncludedGitConfigPath[] = []
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
    const assignment = line.slice(offset).match(/^([a-z][a-z0-9-]*)[ \t\r]*=[ \t\r]*(.*)$/is)
    if (!assignment) {
      continue
    }
    const value = parseConfigValue(assignment[2], lines)
    if (inIncludeSection && assignment[1].toLowerCase() === 'path' && value) {
      const current = resolveIncludedConfigPath(value.value, baseDir)
      const legacy =
        value.legacyValue === undefined
          ? undefined
          : resolveIncludedConfigPath(value.legacyValue, baseDir)
      includedPaths.push(
        legacy !== undefined && legacy !== current ? { current, legacy } : { current }
      )
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

function parseConfigValue(
  firstLine: string,
  lines: Iterator<string>
): { value: string; legacyValue?: string } | null {
  let rawValue = firstLine
  let value = ''
  let legacyValue: string | undefined
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
      let decoded: string
      switch (escaped) {
        case '\\':
        case '"':
          decoded = escaped
          break
        case 't':
          decoded = '\t'
          break
        case 'n':
          decoded = '\n'
          break
        case 'b':
          decoded = '\b'
          break
        default:
          return null
      }
      value += decoded
      if (legacyValue !== undefined) {
        legacyValue += decoded
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
    const unquotedWhitespace = !quoted && /[ \t\r]/.test(char)
    if (unquotedWhitespace) {
      if (!value) {
        continue
      }
      trailingWhitespace ??= value.length
    } else {
      trailingWhitespace = null
    }
    const normalizeWhitespace = unquotedWhitespace && (char === '\t' || char === '\r')
    if (legacyValue !== undefined) {
      legacyValue += normalizeWhitespace ? ' ' : char
    } else if (normalizeWhitespace) {
      legacyValue = `${value} `
    }
    value += char
  }
  if (quoted) {
    return null
  }
  const parsed = trailingWhitespace === null ? value : value.slice(0, trailingWhitespace)
  if (!parsed) {
    return null
  }
  const legacy =
    trailingWhitespace === null ? legacyValue : legacyValue?.slice(0, trailingWhitespace)
  return legacy !== undefined && legacy !== parsed
    ? { value: parsed, legacyValue: legacy }
    : { value: parsed }
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
