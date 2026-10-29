function pathspecScope(pathspec: string): string {
  const scope = pathspec
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '')
  return scope === '.' ? '' : scope
}

export function selectDriveCheckoutSuspectPaths(
  suspects: string[],
  pathspecs: readonly string[]
): string[] {
  if (pathspecs.length === 1) {
    const scope = pathspecScope(pathspecs[0])
    return suspects.filter(
      (suspect) => scope === '' || suspect === scope || suspect.startsWith(`${scope}/`)
    )
  }
  const scopes = new Set<string>()
  for (const pathspec of pathspecs) {
    scopes.add(pathspecScope(pathspec))
  }
  if (scopes.has('')) {
    return suspects
  }
  return suspects.filter((suspect) => {
    // Why length: it bounds ancestor probes without scanning the path to count separators.
    if (suspect.length > scopes.size) {
      for (const scope of scopes) {
        if (suspect === scope || suspect.startsWith(`${scope}/`)) {
          return true
        }
      }
      return false
    }
    for (let end = suspect.length; end > 0; end = suspect.lastIndexOf('/', end - 1)) {
      if (scopes.has(suspect.slice(0, end))) {
        return true
      }
    }
    return false
  })
}
