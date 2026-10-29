import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
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
  let inIncludeSection = false
  let inConditionalIncludeSection = false
  let hasConditionalIncludes = false
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
      inConditionalIncludeSection = section.name === 'includeif' && section.hasSubsection
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
      hasConditionalIncludes ||= inConditionalIncludeSection
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
  return { includedPaths, hasConditionalIncludes }
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
