import type { CSSProperties } from 'react'

// Why: Chromium reshapes a kerned run with no break opportunity at every wrap, quadratic in its
// length (1 MiB of "x": 19 s); past this length kerning goes, which keeps 1 MiB of such runs near 0.2 s.
const KERNED_RUN_MAX_CHARS = 256

export const NATIVE_CHAT_UNKERNED_STYLE = 'font-kerning: none'
export const NATIVE_CHAT_UNKERNED_CSS: CSSProperties = { fontKerning: 'none' }

function breaksRun(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x3000
}

/** `[start, end)` of every whitespace-free run too long to lay out kerned; one linear pass. */
export function nativeChatUnkernedRuns(text: string, limit = Infinity): [number, number][] {
  const runs: [number, number][] = []
  let start = 0
  for (let index = 0; index <= text.length && runs.length < limit; index++) {
    if (index === text.length || breaksRun(text.charCodeAt(index))) {
      if (index - start > KERNED_RUN_MAX_CHARS) {
        runs.push([start, index])
      }
      start = index + 1
    }
  }
  return runs
}

export function nativeChatTextHasUnkernedRun(text: string): boolean {
  return nativeChatUnkernedRuns(text, 1).length > 0
}
