function normalizeGitPathForCompare(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '')
}

function firstTrackedPathAtLeast(paths: readonly string[], value: string): string | undefined {
  let start = 0
  let end = paths.length
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2)
    if (paths[middle] < value) {
      start = middle + 1
    } else {
      end = middle
    }
  }
  return paths[start]
}

function matchesSortedTrackedPathSpec(
  paths: readonly string[],
  normalized: string,
  descendantPrefix: string
): boolean {
  return (
    firstTrackedPathAtLeast(paths, normalized) === normalized ||
    firstTrackedPathAtLeast(paths, descendantPrefix)?.startsWith(descendantPrefix) === true
  )
}

function createTrackedPathSpecMatcher(
  trackedPaths: readonly string[],
  requestCount: number
): (filePath: string) => boolean {
  // Normalize lazily so selecting a directory still stops at its first tracked descendant.
  const normalizedTrackedPaths: string[] = []
  const scanBudget =
    trackedPaths.length > 1 && requestCount > 1
      ? trackedPaths.length * Math.ceil(Math.log2(trackedPaths.length))
      : Infinity
  let comparisons = 0
  let remainingRequests = requestCount
  let indexed = false
  return (filePath) => {
    remainingRequests -= 1
    const normalized = normalizeGitPathForCompare(filePath)
    const descendantPrefix = `${normalized}/`
    if (indexed) {
      return matchesSortedTrackedPathSpec(normalizedTrackedPaths, normalized, descendantPrefix)
    }
    for (let index = 0; index < trackedPaths.length; index += 1) {
      const normalizedTracked = (normalizedTrackedPaths[index] ??= normalizeGitPathForCompare(
        trackedPaths[index]
      ))
      comparisons += 1
      if (normalizedTracked === normalized || normalizedTracked.startsWith(descendantPrefix)) {
        return true
      }
      if (remainingRequests > 0 && comparisons >= scanBudget && index + 1 < trackedPaths.length) {
        for (let pending = index + 1; pending < trackedPaths.length; pending += 1) {
          normalizedTrackedPaths[pending] ??= normalizeGitPathForCompare(trackedPaths[pending])
        }
        normalizedTrackedPaths.sort()
        indexed = true
        return matchesSortedTrackedPathSpec(normalizedTrackedPaths, normalized, descendantPrefix)
      }
    }
    return false
  }
}

export function isTrackedPathSpec(filePath: string, trackedPaths: readonly string[]): boolean {
  return createTrackedPathSpecMatcher(trackedPaths, 1)(filePath)
}

export function partitionTrackedPathSpecs(
  filePaths: readonly string[],
  trackedPathSpecs: readonly string[]
): { trackedPaths: string[]; untrackedPaths: string[] } {
  const isTracked = createTrackedPathSpecMatcher(trackedPathSpecs, filePaths.length)
  const trackedPaths: string[] = []
  const untrackedPaths: string[] = []
  // Keep original spellings, duplicates and order: these arrays select restore versus clean.
  for (const filePath of filePaths) {
    ;(isTracked(filePath) ? trackedPaths : untrackedPaths).push(filePath)
  }
  return { trackedPaths, untrackedPaths }
}
