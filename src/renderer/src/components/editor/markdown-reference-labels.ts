import { createReferenceDefinitionSuffixIndex } from './markdown-reference-definition-suffix-index'

export function normalizeReferenceLabel(label: string): string {
  return collapseReferenceLabelWhitespace(label).toLowerCase()
}

function collapseReferenceLabelWhitespace(label: string, preserveOuterWhitespace = false): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < label.length; index += 1) {
    const code = label.charCodeAt(index)
    if (isMarkdownReferenceLabelWhitespace(code)) {
      pendingWhitespace = preserveOuterWhitespace || normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += label.charAt(index)
  }
  if (preserveOuterWhitespace && pendingWhitespace) {
    normalized += ' '
  }
  return normalized
}

// Large labels only need collapsed reference whitespace; avoid scanning them again with a full-string regex.
function isMarkdownReferenceLabelWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

type ReferenceTextCharacterCounts = {
  openingBrackets: number
  nonWhitespaceCodePoints: number
}

function countReferenceTextCharacters(
  content: string,
  start: number,
  end: number
): ReferenceTextCharacterCounts {
  let openingBrackets = 0
  let nonWhitespaceCodePoints = 0
  for (let index = start; index < end; index += 1) {
    const code = content.charCodeAt(index)
    if (code === 91) {
      openingBrackets += 1
    }
    if (!isMarkdownReferenceLabelWhitespace(code)) {
      nonWhitespaceCodePoints += 1
      const next = content.charCodeAt(index + 1)
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < end && next >= 0xdc00 && next <= 0xdfff) {
        index += 1
      }
    }
  }
  return { openingBrackets, nonWhitespaceCodePoints }
}

export function createReferenceTextDefinitionLookup<T>(
  markdown: string,
  definitions: Map<string, T>
): (text: string, start: number, end: number) => T | undefined {
  let definitionMaximumLengths: Map<number, number> | undefined
  let previousStart = 0
  let previousEnd = -1
  let textCounts: ReferenceTextCharacterCounts | null = null
  let suffixIndex: ReturnType<typeof createReferenceDefinitionSuffixIndex<T>> | null = null
  let suffixMatches: Map<number, T> | null = null
  let normalizedStart = 0
  let normalizedEnd = 0
  let minimumDefinitionBrackets = Number.POSITIVE_INFINITY
  return (text, start, end) => {
    const lastStart = previousStart
    previousStart = start
    if (end === previousEnd) {
      if (!definitionMaximumLengths) {
        definitionMaximumLengths = new Map<number, number>()
        for (const label of definitions.keys()) {
          const count = countReferenceTextCharacters(label, 0, label.length).openingBrackets
          minimumDefinitionBrackets = Math.min(minimumDefinitionBrackets, count)
          definitionMaximumLengths.set(
            count,
            Math.max(definitionMaximumLengths.get(count) ?? 0, label.length)
          )
        }
      }
      if (textCounts === null) {
        textCounts = countReferenceTextCharacters(markdown, start, end)
      } else {
        const removed = countReferenceTextCharacters(markdown, lastStart, start)
        textCounts.openingBrackets -= removed.openingBrackets
        textCounts.nonWhitespaceCodePoints -= removed.nonWhitespaceCodePoints
        if (suffixMatches !== null) {
          // Every removed prefix ends at [, which blocks contextual casing across the boundary.
          normalizedStart += collapseReferenceLabelWhitespace(
            markdown.slice(lastStart, start),
            true
          ).toLowerCase().length
        }
      }
      const maximumLength = definitionMaximumLengths.get(textCounts.openingBrackets)
      if (maximumLength === undefined || textCounts.nonWhitespaceCodePoints > maximumLength) {
        return undefined
      }
      if (suffixMatches === null) {
        if (textCounts.openingBrackets === minimumDefinitionBrackets) {
          return definitions.get(normalizeReferenceLabel(text))
        }
        suffixIndex ??= createReferenceDefinitionSuffixIndex(definitions)
        const normalized = collapseReferenceLabelWhitespace(text, true).toLowerCase()
        const trailingWhitespace = isMarkdownReferenceLabelWhitespace(markdown.charCodeAt(end - 1))
        normalizedEnd = normalized.length - (trailingWhitespace ? 1 : 0)
        suffixMatches = suffixIndex(normalized, normalizedEnd)
        normalizedStart = 0
      }
      const leadingWhitespace = isMarkdownReferenceLabelWhitespace(markdown.charCodeAt(start))
      return suffixMatches.get(
        Math.min(normalizedEnd, normalizedStart + (leadingWhitespace ? 1 : 0))
      )
    }
    previousEnd = end
    textCounts = null
    suffixMatches = null
    normalizedStart = 0
    normalizedEnd = 0
    return definitions.get(normalizeReferenceLabel(text))
  }
}
