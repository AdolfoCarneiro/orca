// One report must name one folder in both OSC 7 parsers: the daemon's (checkpoints, restores) reads
// raw PTY bytes; the renderer's (split, new terminal) reads what xterm's OSC parser hands it. Each
// side's tests run these cases, including what nushell sends raw.
export type Osc7AgreementCase = {
  name: string
  /** The report as the shell writes it, between `ESC ]7;` and BEL. */
  uri: string
  /** The folder both parsers name, or null when the report is refused. */
  folder: string | null
  /**
   * Known renderer gap: xterm's OSC parser drops raw C0 bytes before the renderer sees the
   * payload, so the renderer names this instead of `folder`.
   */
  viaXterm?: string | null
}

export const OSC7_PARSER_AGREEMENT_CASES: readonly Osc7AgreementCase[] = [
  { name: 'a raw tab', uri: 'file://Desktop/tmp/a\tb', folder: '/tmp/a\tb', viaXterm: '/tmp/ab' },
  {
    name: 'a raw newline',
    uri: 'file://Desktop/tmp/a\nb',
    folder: '/tmp/a\nb',
    viaXterm: '/tmp/ab'
  },
  {
    name: 'a raw carriage return',
    uri: 'file://Desktop/tmp/a\rb',
    folder: '/tmp/a\rb',
    viaXterm: '/tmp/ab'
  },
  { name: 'a trailing space', uri: 'file://Desktop/tmp/a ', folder: '/tmp/a ' },
  { name: 'a space inside', uri: 'file://Desktop/tmp/a b', folder: '/tmp/a b' },
  { name: 'a lone %', uri: 'file://Desktop/tmp/100%', folder: '/tmp/100%' },
  { name: 'a # and ?', uri: 'file://Desktop/tmp/h#a?b', folder: '/tmp/h#a?b' },
  { name: 'an encoded newline', uri: 'file:///tmp/a%0Ab', folder: '/tmp/a\nb' },
  { name: 'a leading raw NUL', uri: 'file:///\u0000tmp', folder: null, viaXterm: '/tmp' },
  { name: 'a trailing raw NUL', uri: 'file:///tmp/a\u0000', folder: null, viaXterm: '/tmp/a' },
  { name: 'an encoded NUL', uri: 'file:///tmp/%00', folder: null },
  { name: 'non-UTF-8 hex', uri: 'file:///tmp/%FF', folder: null }
]
