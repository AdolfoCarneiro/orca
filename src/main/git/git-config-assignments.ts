export type DecodedGitConfigValue = { value: string; legacyValue?: string }
export type GitConfigAssignment = {
  section: { name: string; hasSubsection: boolean } | undefined
  key: string
  value: { kind: 'implicit' } | { kind: 'explicit'; decoded: DecodedGitConfigValue | null }
}

export function* scanGitConfigAssignments(configText: string): Generator<GitConfigAssignment> {
  let currentSection: GitConfigAssignment['section']
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
      currentSection = { name: section.name, hasSubsection: section.hasSubsection }
      offset = section.end
      while (line[offset] === ' ' || line[offset] === '\t') {
        offset += 1
      }
    }
    const rest = line.slice(offset)
    const assignment = rest.match(/^([a-z][a-z0-9-]*)[ \t\r]*=[ \t\r]*(.*)$/is)
    if (assignment) {
      const decoded = parseConfigValue(assignment[2], lines)
      yield {
        section: currentSection,
        key: assignment[1].toLowerCase(),
        value: { kind: 'explicit', decoded }
      }
      continue
    }
    const implicit = rest.match(/^([a-z][a-z0-9-]*)[ \t\r]*(?:[#;].*)?$/is)
    if (implicit) {
      yield { section: currentSection, key: implicit[1].toLowerCase(), value: { kind: 'implicit' } }
    }
  }
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
