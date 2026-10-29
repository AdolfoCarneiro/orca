import { useEffect, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, ChevronRight, Eye, Hand, Plus, Square, X } from 'lucide-react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { usePrefersReducedMotion } from '@/components/feature-wall/feature-wall-modal-helpers'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import {
  CHAT_DEMO_FINISHED_AT,
  CHAT_DEMO_FLOW,
  CHAT_DEMO_LOOP_MS,
  CHAT_DEMO_MODEL,
  CHAT_DEMO_PERMISSION,
  CHAT_DEMO_PLACEHOLDER,
  CHAT_DEMO_PROMPT,
  CHAT_DEMO_REPLY,
  CHAT_DEMO_TAB_TITLE,
  CHAT_DEMO_TOOL,
  CHAT_DEMO_WORKING,
  chatDemoFrameAt,
  nextChatDemoBeat,
  type ChatDemoFrame
} from './chat-ui-here-feature-tip-demo'

// The smallest chat text size, so the real chat spacing fits the 22rem card the sibling visuals use.
const CHAT_SCALE = { '--chat-font-size': '12px' } as CSSProperties
const FLOW_WIDTH = 318
const FLOW_GAP =
  (FLOW_WIDTH - 2 - CHAT_DEMO_FLOW.reduce((sum, node) => sum + node.width, 0)) /
  (CHAT_DEMO_FLOW.length - 1)

/** A row that takes no height until it appears, so the transcript grows from its end. */
function Row({ on, children }: { on: boolean; children: ReactNode }): JSX.Element {
  return (
    <div
      data-on={on}
      className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-300 ease-out data-[on=true]:grid-rows-[1fr] data-[on=true]:opacity-100"
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

function FlowDiagram({ frame }: { frame: ChatDemoFrame }): JSX.Element {
  let x = 1
  const nodes = CHAT_DEMO_FLOW.map((node, index) => {
    const left = x
    x += node.width + FLOW_GAP
    const arrowStart = left + node.width + 4
    const arrowEnd = left + node.width + FLOW_GAP - 4
    const arrowOn = index < frame.arrows
    return (
      <g key={node.name}>
        {node.arrow !== null ? (
          <g className="fill-none stroke-chart-3 [stroke-width:1.25]">
            <path
              d={`M${arrowStart} 45 L${arrowEnd - 1} 45`}
              pathLength={1}
              strokeDasharray={1}
              className="transition-[stroke-dashoffset] duration-300 ease-in-out"
              style={{ strokeDashoffset: arrowOn ? 0 : 1 }}
            />
            <path
              d={`M${arrowEnd - 4} 42 L${arrowEnd} 45 L${arrowEnd - 4} 48`}
              strokeLinecap="round"
              strokeLinejoin="round"
              data-on={arrowOn}
              className="opacity-0 transition-opacity delay-250 duration-100 data-[on=true]:opacity-100"
            />
            {node.arrow ? (
              <text
                x={(arrowStart + arrowEnd) / 2}
                y={23}
                textAnchor="middle"
                data-on={arrowOn}
                className="fill-chat-foreground-faint stroke-none text-[9px] opacity-0 transition-opacity delay-100 duration-300 data-[on=true]:opacity-100"
              >
                {node.arrow}
              </text>
            ) : null}
          </g>
        ) : null}
        <g
          data-on={index < frame.nodes}
          className="origin-center scale-[0.94] opacity-0 transition-[opacity,scale] duration-300 ease-out [transform-box:fill-box] data-[on=true]:scale-100 data-[on=true]:opacity-100"
        >
          <rect
            x={left}
            y={30}
            width={node.width}
            height={30}
            rx={7}
            className="fill-[color-mix(in_srgb,var(--chart-1)_16%,var(--chat-canvas))] stroke-[color:color-mix(in_srgb,var(--chart-3)_55%,transparent)]"
          />
          <text
            x={left + node.width / 2}
            y={49}
            textAnchor="middle"
            className="fill-chat-foreground-strong text-[10.5px] font-medium"
          >
            {node.name}
          </text>
        </g>
      </g>
    )
  })
  return (
    <svg viewBox={`0 0 ${FLOW_WIDTH} 70`} width="100%" height={70} className="block">
      {nodes}
    </svg>
  )
}

function Transcript({ frame }: { frame: ChatDemoFrame }): JSX.Element {
  let wordIndex = 0
  return (
    <div
      className="flex min-h-full shrink-0 flex-col transition-opacity duration-700 ease-in-out"
      style={{ opacity: frame.faded ? 0 : 1 }}
    >
      {/* The sent message rises out of the composer at full height, so only its position moves. */}
      <div
        data-on={frame.sent}
        className="grid grid-rows-[0fr] translate-y-[150px] opacity-0 transition-[opacity,translate] duration-450 ease-[cubic-bezier(0.22,1,0.36,1)] data-[on=true]:grid-rows-[1fr] data-[on=true]:translate-y-0 data-[on=true]:opacity-100"
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-4 flex flex-col items-end">
            <div className="max-w-[80%] rounded-xl border border-chat-user-border bg-chat-user-surface px-3.5 py-2.5 text-chat-foreground-strong">
              {CHAT_DEMO_PROMPT}
            </div>
          </div>
        </div>
      </div>
      <Row on={frame.tool}>
        <div className="mt-5 flex min-h-6.5 items-center gap-2 whitespace-nowrap">
          <span className="flex size-4 items-center justify-center text-chat-foreground-faint">
            <Eye className="size-3.5" />
          </span>
          <span className="text-chat-foreground-faint">{CHAT_DEMO_TOOL.verb}</span>
          <span>{CHAT_DEMO_TOOL.target}</span>
          <ChevronRight className="ml-auto size-3.5 text-chat-foreground-faint" />
        </div>
      </Row>
      <Row on={frame.working}>
        <div className="mt-5 flex min-h-6 items-center gap-1.5 text-chat-foreground-faint">
          <LoadingSpinner className="size-4 shrink-0" />
          <span className="text-chat-foreground">{CHAT_DEMO_WORKING}</span>
        </div>
      </Row>
      {CHAT_DEMO_REPLY.map((line, lineIndex) => {
        const firstWord = wordIndex
        wordIndex += line.length
        return (
          <Row key={firstWord} on={frame.words > firstWord}>
            <p className={cn('whitespace-nowrap', lineIndex === 0 && 'mt-5')}>
              {line.map(({ word, link }, index) => (
                <span
                  key={word + index}
                  data-on={frame.words > firstWord + index}
                  className="opacity-0 transition-opacity duration-100 data-[on=true]:opacity-100"
                >
                  {index > 0 && word !== ':' ? ' ' : null}
                  {link ? (
                    <span className="text-chat-foreground-strong underline decoration-current/40 underline-offset-2">
                      {word}
                    </span>
                  ) : (
                    word
                  )}
                </span>
              ))}
            </p>
          </Row>
        )
      })}
      <Row on={frame.visual}>
        <div className="relative mt-2.5 mb-0.5">
          <div
            data-on={!frame.page}
            className="absolute inset-0 rounded-md bg-muted/30 opacity-0 transition-opacity duration-300 data-[on=true]:opacity-100"
          />
          <div
            data-on={frame.page}
            className="relative opacity-0 transition-opacity duration-300 data-[on=true]:opacity-100"
          >
            <FlowDiagram frame={frame} />
          </div>
        </div>
      </Row>
    </div>
  )
}

function Composer({ frame }: { frame: ChatDemoFrame }): JSX.Element {
  const typing = frame.typed > 0
  return (
    <div className="shrink-0 px-3 pt-1.5 pb-3">
      <div className="rounded-lg border border-chat-composer-border bg-chat-composer-surface p-1 shadow-xs">
        <div className="relative min-h-8 overflow-hidden px-2 py-0.5 whitespace-nowrap">
          {typing ? (
            <span className="whitespace-pre text-chat-foreground-strong">
              {CHAT_DEMO_PROMPT.slice(0, frame.typed)}
              <span className="ml-px inline-block h-[14px] w-px bg-chat-foreground-strong align-[-3px]" />
            </span>
          ) : (
            <span className="text-chat-foreground-faint">{CHAT_DEMO_PLACEHOLDER}</span>
          )}
        </div>
        <div className="flex items-center justify-between gap-1.5 text-chat-foreground-faint">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="flex size-6.5 items-center justify-center">
              <Plus className="size-3.5" />
            </span>
            <span className="flex h-5.5 items-center gap-1 px-1.5 text-xs font-medium whitespace-nowrap">
              <Hand className="size-3" />
              {CHAT_DEMO_PERMISSION}
              <ChevronDown className="size-3" />
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="flex h-5.5 items-center gap-1 px-1.5 text-xs font-medium whitespace-nowrap text-chat-foreground">
              {CHAT_DEMO_MODEL}
              <ChevronDown className="size-3 text-chat-foreground-faint" />
            </span>
            <span className="relative size-6.5">
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center rounded-full bg-primary text-primary-foreground transition-[opacity,scale] duration-100',
                  frame.send === 'empty' && 'opacity-50',
                  frame.send === 'pressed' && 'scale-[0.88]',
                  frame.send === 'stop' && 'opacity-0'
                )}
              >
                <ArrowUp className="size-3.5" />
              </span>
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center rounded-full bg-secondary text-secondary-foreground transition-opacity duration-100',
                  frame.send !== 'stop' && 'opacity-0'
                )}
              >
                <Square className="size-3 fill-current" />
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A miniature chat that sends one question and draws its reply, then fades and starts over. */
export function ChatUiHereFeatureTipVisual(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const [at, setAt] = useState(0)
  const frame = chatDemoFrameAt(reducedMotion ? CHAT_DEMO_FINISHED_AT : at)

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    const next = nextChatDemoBeat(at)
    const timeoutId = window.setTimeout(
      () => setAt(next >= CHAT_DEMO_LOOP_MS ? 0 : next),
      next - at
    )
    return () => window.clearTimeout(timeoutId)
  }, [at, reducedMotion])

  return (
    <div
      className="relative flex h-full min-h-[23rem] flex-col items-center justify-center overflow-hidden px-6 py-7"
      aria-hidden="true"
    >
      <div className="flex h-[22rem] w-full max-w-[22rem] flex-col overflow-hidden rounded-xl border border-border/80 bg-chat-canvas text-left tracking-[0.01em] shadow-xs">
        <div className="flex h-10 shrink-0 items-stretch border-b border-border bg-card">
          <span className="-mb-px flex items-center gap-1.5 border-r border-border bg-chat-canvas px-3 text-[11px] whitespace-nowrap text-foreground">
            <AgentIcon agent="claude" size={12} />
            {CHAT_DEMO_TAB_TITLE}
            <X className="ml-1 size-2.5 text-muted-foreground" />
          </span>
        </div>
        <div
          className="native-chat-appearance flex min-h-0 flex-1 flex-col text-sm leading-relaxed text-chat-foreground"
          style={CHAT_SCALE}
        >
          {/* Bottom-anchored, so a transcript taller than the card keeps its end in view. */}
          <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-[calc(var(--spacing)*3+5px)]">
            <Transcript frame={frame} />
          </div>
          <Composer frame={frame} />
        </div>
      </div>
    </div>
  )
}
