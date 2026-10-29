// One recorded English chat replayed by the tip's miniature; it is sample session content, so it
// stays as written in every locale, like an agent's own words.
export const CHAT_DEMO_TAB_TITLE = 'Explain login'
export const CHAT_DEMO_PROMPT = 'Map out how login works'
export const CHAT_DEMO_PLACEHOLDER = 'Ask anything, @ to mention files, / for commands'
export const CHAT_DEMO_PERMISSION = 'Ask for approval'
export const CHAT_DEMO_MODEL = 'Opus'
export const CHAT_DEMO_WORKING = 'Working…'
export const CHAT_DEMO_TOOL = { verb: 'Read', target: 'auth.ts' }
/** The reply's lines as they wrap at 12px in the card; `link` marks the underlined file link. */
export const CHAT_DEMO_REPLY: readonly (readonly { word: string; link?: true }[])[] = [
  [
    ...'Login starts in'.split(' ').map((word) => ({ word })),
    { word: 'auth.ts', link: true },
    ...': the browser posts to /login,'.split(' ').map((word) => ({ word }))
  ],
  'the server checks the password and creates a session,'.split(' ').map((word) => ({ word })),
  'then redirects you to the app. Here’s the flow:'.split(' ').map((word) => ({ word }))
]
export const CHAT_DEMO_FLOW = [
  { name: 'Browser', width: 62, arrow: 'password' },
  { name: '/login', width: 54, arrow: '' },
  { name: 'Session', width: 62, arrow: 'cookie' },
  { name: 'App', width: 44, arrow: null }
] as const

const WORD_COUNT = CHAT_DEMO_REPLY.flat().length

/** Milliseconds into the 12.9 s loop at which each beat starts. */
const AT = {
  typeStart: 150,
  typeLength: 1350,
  press: 1720,
  pressLength: 200,
  sent: 1950,
  working: 2600,
  tool: 3400,
  replyStart: 4400,
  replyLength: 1500,
  visual: 6050,
  page: 6400,
  firstNode: 6500,
  nodeStep: 600,
  arrowLag: 300,
  done: 8800,
  fadeOut: 11600,
  empty: 12300,
  loop: 12900
}

const charAt = (index: number): number =>
  AT.typeStart + (index / CHAT_DEMO_PROMPT.length) * AT.typeLength
const wordAt = (index: number): number => AT.replyStart + (index / WORD_COUNT) * AT.replyLength
const nodeAt = (index: number): number => AT.firstNode + index * AT.nodeStep

export type ChatDemoSend = 'empty' | 'ready' | 'pressed' | 'stop'

export type ChatDemoFrame = {
  typed: number
  send: ChatDemoSend
  sent: boolean
  working: boolean
  tool: boolean
  words: number
  visual: boolean
  page: boolean
  nodes: number
  arrows: number
  /** The transcript fades as one; its rows keep their finished state until it is transparent. */
  faded: boolean
}

const count = (times: readonly number[], at: number): number =>
  times.filter((time) => time <= at).length

const CHAR_TIMES = Array.from(CHAT_DEMO_PROMPT, (_, index) => charAt(index))
const WORD_TIMES = Array.from({ length: WORD_COUNT }, (_, index) => wordAt(index))
const NODE_TIMES = CHAT_DEMO_FLOW.map((_, index) => nodeAt(index))
const ARROW_TIMES = NODE_TIMES.slice(0, -1).map((time) => time + AT.arrowLag)

export function chatDemoFrameAt(at: number): ChatDemoFrame {
  const live = at < AT.empty
  const typing = at >= AT.typeStart && at < AT.sent
  const turnRunning = at >= AT.sent && at < AT.done
  const pressed = at >= AT.press && at < AT.press + AT.pressLength
  return {
    typed: typing ? count(CHAR_TIMES, at) : 0,
    send: turnRunning ? 'stop' : pressed ? 'pressed' : typing ? 'ready' : 'empty',
    sent: live && at >= AT.sent,
    working: at >= AT.working && at < AT.replyStart,
    tool: live && at >= AT.tool,
    words: live ? count(WORD_TIMES, at) : 0,
    visual: live && at >= AT.visual,
    page: live && at >= AT.page,
    nodes: live ? count(NODE_TIMES, at) : 0,
    arrows: live ? count(ARROW_TIMES, at) : 0,
    faded: at >= AT.fadeOut
  }
}

/** The held, finished frame; also the reduced-motion still. */
export const CHAT_DEMO_FINISHED_AT = AT.done

const BEATS = [
  ...new Set([
    ...CHAR_TIMES,
    ...WORD_TIMES,
    ...NODE_TIMES,
    ...ARROW_TIMES,
    AT.press,
    AT.press + AT.pressLength,
    AT.sent,
    AT.working,
    AT.tool,
    AT.replyStart,
    AT.visual,
    AT.page,
    AT.done,
    AT.fadeOut,
    AT.empty,
    AT.loop
  ])
].sort((a, b) => a - b)

/** The next moment the frame changes; the loop's end wraps to 0. */
export function nextChatDemoBeat(at: number): number {
  return BEATS.find((beat) => beat > at) ?? AT.loop
}

export const CHAT_DEMO_LOOP_MS = AT.loop
