import { Lexer, Tokenizer, type Token, type Tokens } from 'marked'

const NON_WHITESPACE = /\S/

type MarkdownClosingDelimiter = '*' | '_' | '~'

export class MarkdownClosingDelimiterBounds {
  private maskedSource: string | undefined
  private readonly lastClosingDelimiters = new Map<MarkdownClosingDelimiter, number>()

  hasPossibleClosingDelimiter(
    source: string,
    maskedSource: string,
    marker: MarkdownClosingDelimiter
  ): boolean {
    if (this.maskedSource !== maskedSource) {
      this.maskedSource = maskedSource
      this.lastClosingDelimiters.clear()
    }
    let lastClosingDelimiter = this.lastClosingDelimiters.get(marker)
    if (lastClosingDelimiter === undefined) {
      lastClosingDelimiter = maskedSource.lastIndexOf(marker)
      while (lastClosingDelimiter >= 0) {
        let runStart = lastClosingDelimiter
        while (maskedSource[runStart - 1] === marker) {
          runStart--
        }
        // Stock closing alternatives require non-whitespace before the marker run.
        if (runStart > 0 && NON_WHITESPACE.test(maskedSource[runStart - 1])) {
          break
        }
        lastClosingDelimiter = runStart === 0 ? -1 : maskedSource.lastIndexOf(marker, runStart - 1)
      }
      this.lastClosingDelimiters.set(marker, lastClosingDelimiter)
    }
    if (lastClosingDelimiter < 0) {
      return false
    }
    let openingLength = 0
    while (source[openingLength] === marker) {
      openingLength++
    }
    return lastClosingDelimiter >= Math.max(0, maskedSource.length - source.length + openingLength)
  }
}

const DEFAULT_LEFT_EMPHASIS_RULES = new Set(
  Object.values(Lexer.rules.inline).map((rules) => rules.emStrongLDelim)
)
const DEFAULT_LEFT_STRIKE_RULES = new Set(
  Object.values(Lexer.rules.inline).map((rules) => rules.delLDelim)
)
const DEFAULT_ASTERISK_RULES = new Set(
  Object.values(Lexer.rules.inline).map((rules) => rules.emStrongRDelimAst)
)
const DEFAULT_UNDERSCORE_RULES = new Set(
  Object.values(Lexer.rules.inline).map((rules) => rules.emStrongRDelimUnd)
)
const DEFAULT_STRIKE_RULES = new Set(
  Object.values(Lexer.rules.inline).map((rules) => rules.delRDelim)
)

const DEFAULT_REGEXP_EXEC = RegExp.prototype.exec
const DEFAULT_DELIMITER_RULE_SIGNATURES = new Map(
  [
    ...DEFAULT_LEFT_EMPHASIS_RULES,
    ...DEFAULT_LEFT_STRIKE_RULES,
    ...DEFAULT_ASTERISK_RULES,
    ...DEFAULT_UNDERSCORE_RULES,
    ...DEFAULT_STRIKE_RULES
  ].map((rule) => [rule, { source: rule.source, flags: rule.flags }] as const)
)

function isUnchangedDelimiterRule(rule: RegExp): boolean {
  const original = DEFAULT_DELIMITER_RULE_SIGNATURES.get(rule)
  return (
    original !== undefined &&
    rule.source === original.source &&
    rule.flags === original.flags &&
    rule.exec === DEFAULT_REGEXP_EXEC
  )
}

export class MarkdownClosingDelimiterTokenizer extends Tokenizer {
  private inlineDelimiterBounds: MarkdownClosingDelimiterBounds | null | undefined

  withInlineDelimiterBounds(tokenize: () => Token[]): Token[] {
    const previousBounds = this.inlineDelimiterBounds
    this.inlineDelimiterBounds = null
    try {
      return tokenize()
    } finally {
      this.inlineDelimiterBounds = previousBounds
    }
  }

  emStrong(
    source: string,
    maskedSource: string,
    previousCharacter = ''
  ): Tokens.Em | Tokens.Strong | undefined {
    const marker = source[0]
    if (
      (marker === '*' || marker === '_') &&
      this.inlineDelimiterBounds !== undefined &&
      DEFAULT_LEFT_EMPHASIS_RULES.has(this.rules.inline.emStrongLDelim) &&
      isUnchangedDelimiterRule(this.rules.inline.emStrongLDelim) &&
      isUnchangedDelimiterRule(
        marker === '*' ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd
      ) &&
      (marker === '*' ? DEFAULT_ASTERISK_RULES : DEFAULT_UNDERSCORE_RULES).has(
        marker === '*' ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd
      ) &&
      !(this.inlineDelimiterBounds ??=
        new MarkdownClosingDelimiterBounds()).hasPossibleClosingDelimiter(
        source,
        maskedSource,
        marker
      )
    ) {
      return super.emStrong(source, '', previousCharacter)
    }
    return super.emStrong(source, maskedSource, previousCharacter)
  }

  del(source: string, maskedSource: string, previousCharacter = ''): Tokens.Del | undefined {
    if (
      source[0] === '~' &&
      this.inlineDelimiterBounds !== undefined &&
      DEFAULT_LEFT_STRIKE_RULES.has(this.rules.inline.delLDelim) &&
      isUnchangedDelimiterRule(this.rules.inline.delLDelim) &&
      isUnchangedDelimiterRule(this.rules.inline.delRDelim) &&
      DEFAULT_STRIKE_RULES.has(this.rules.inline.delRDelim) &&
      !(this.inlineDelimiterBounds ??=
        new MarkdownClosingDelimiterBounds()).hasPossibleClosingDelimiter(source, maskedSource, '~')
    ) {
      return super.del(source, '', previousCharacter)
    }
    return super.del(source, maskedSource, previousCharacter)
  }
}
