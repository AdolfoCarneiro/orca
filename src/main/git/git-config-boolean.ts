import { scanGitConfigAssignments } from './git-config-assignments'

// `section` and `key` must be lowercase: git config names are case-insensitive.
export function parseGitConfigFlag(
  configContent: string,
  section: string,
  key: string
): boolean | undefined {
  let value: boolean | undefined
  for (const assignment of scanGitConfigAssignments(configContent)) {
    if (
      assignment.section?.name !== section ||
      assignment.section.hasSubsection ||
      assignment.key !== key
    ) {
      continue
    }
    if (assignment.value.kind === 'implicit') {
      value = true
      continue
    }
    const decoded = assignment.value.decoded
    if (!decoded) {
      value = false
      continue
    }
    const current = parseDecodedGitConfigBoolean(decoded.value)
    const legacy =
      decoded.legacyValue === undefined
        ? current
        : parseDecodedGitConfigBoolean(decoded.legacyValue)
    value = current === legacy ? current : false
  }
  return value
}

function parseDecodedGitConfigBoolean(decoded: string): boolean {
  const value = decoded.toLowerCase()
  if (value === 'true' || value === 'yes' || value === 'on') {
    return true
  }
  const numeric = value.match(/^[ \t\r\n\v\f]*[+-]?(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)([kmg]?)$/)
  if (!numeric) {
    return false
  }
  const digits = numeric[1]
  const radix = digits.startsWith('0x') ? 16 : digits.startsWith('0') ? 8 : 10
  const exponent = ['', 'k', 'm', 'g'].indexOf(numeric[2])
  const magnitude = Number.parseInt(digits, radix) * 1024 ** exponent
  // Git 2.25 rejects the extra negative endpoint accepted by newer Git.
  return magnitude > 0 && magnitude <= 2_147_483_647
}
