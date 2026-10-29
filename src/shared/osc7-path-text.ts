// Rules both OSC 7 parsers (the daemon's and the renderer's) share, so they agree on a folder.

/** A `%` not followed by two hex digits is a literal `%` (nushell sends folder names unencoded). */
export function escapeLiteralPercent(text: string): string {
  return text.replace(/%(?![0-9A-Fa-f]{2})/g, '%25')
}

// node-pty silently truncates a cwd at NUL and execFile can throw on one; refusing keeps the last good folder.
// oxlint-disable-next-line no-control-regex -- matching C0 controls is the point.
const C0_CONTROL = /[\u0000-\u001f]/

/** A decoded folder that a spawn could not use as its cwd. */
export function hasControlCharacter(path: string): boolean {
  return C0_CONTROL.test(path)
}
