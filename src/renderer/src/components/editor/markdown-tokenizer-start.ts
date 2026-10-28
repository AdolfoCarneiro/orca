type MarkdownTokenizerStart = (source: string) => number | void

const startMarkers = new WeakMap<MarkdownTokenizerStart, string>()
const startCursorFactories = new WeakMap<MarkdownTokenizerStart, () => MarkdownTokenizerStart>()

export function registerMarkdownTokenizerStart(marker: string, start: (source: string) => number) {
  startMarkers.set(start, marker)
  return start
}

/** Let a lexer skip suffix searches for markers absent from its entire input. */
export function createMarkdownTokenizerStart(marker: string, lineStart = false) {
  const start = (source: string): number => {
    let position = source.indexOf(marker)
    while (lineStart && position > 0 && !'\n\r\u2028\u2029'.includes(source[position - 1])) {
      position = source.indexOf(marker, position + marker.length)
    }
    return position
  }
  if (lineStart && /[\n\r\u2028\u2029]/.test(marker)) {
    return registerMarkdownTokenizerStart(marker, start)
  }
  startCursorFactories.set(start, () => {
    let firstLength: number | undefined
    let nextPosition: number | undefined
    return (source) => {
      firstLength ??= source.length
      const position = firstLength - source.length
      // A suffix can begin at a marker an earlier line-start search skipped.
      if (lineStart && source.startsWith(marker)) {
        return 0
      }
      if (nextPosition === -1) {
        return -1
      }
      if (nextPosition !== undefined && nextPosition >= position) {
        return nextPosition - position
      }
      const match = start(source)
      nextPosition = match === -1 ? -1 : position + match
      return match
    }
  })
  return registerMarkdownTokenizerStart(marker, start)
}

export function getMarkdownTokenizerStartMarker(start: (source: string) => number | void) {
  return startMarkers.get(start)
}

/** Bind to one lexer call, where Marked passes monotonically shorter suffixes. */
export function createMarkdownTokenizerStartCursor(
  start: MarkdownTokenizerStart
): MarkdownTokenizerStart {
  return startCursorFactories.get(start)?.() ?? start
}
