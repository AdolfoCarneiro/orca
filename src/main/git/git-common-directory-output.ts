export function readGitCommonDirectoryOutput(stdout: string): string | undefined {
  const unsupportedOption = '--path-format=absolute\n'
  const payload = stdout.startsWith(unsupportedOption)
    ? stdout.slice(unsupportedOption.length)
    : stdout
  const commonDir = payload.endsWith('\n') ? payload.slice(0, -1) : payload
  return commonDir || undefined
}
