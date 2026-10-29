import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import type { AgentPickerDraft, AgentPickerEntry } from '../../../../shared/agent-launch-picker'

function setupKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.click()
  } else if (['ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    const row = event.currentTarget.closest<HTMLElement>('[role="menuitem"]')
    if (row) {
      event.preventDefault()
      event.stopPropagation()
      row.focus()
      if (event.key !== 'ArrowLeft') {
        row.dispatchEvent(new window.KeyboardEvent('keydown', { key: event.key, bubbles: true }))
      }
    }
  }
}

export function AgentLaunchSetupButton({
  entry,
  initial,
  renderAnchor,
  disabled,
  onOpenChange,
  onUse
}: {
  entry: AgentPickerEntry
  initial?: AgentPickerDraft
  renderAnchor?: (trigger: ReactElement) => ReactElement
  disabled?: boolean
  onOpenChange?: (open: boolean) => void
  onUse: (draft: AgentPickerDraft) => void
}) {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<'right' | 'bottom'>('right')
  const content = useRef<HTMLDivElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      // Let Radix publish collision space after the external resize and horizontal placement.
      frame = requestAnimationFrame(() => {
        flushSync(() => setPlacement('right'))
        frame = requestAnimationFrame(() => {
          if (!content.current) {
            return
          }
          const style = window.getComputedStyle(content.current)
          const available = Number.parseFloat(
            style.getPropertyValue('--radix-popover-content-available-width')
          )
          if (available < Number.parseFloat(style.minWidth)) {
            setPlacement('bottom')
          }
        })
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(document.documentElement)
    if (anchor.current) {
      observer.observe(anchor.current)
    }
    measure()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [open])
  const changeOpen = (next: boolean) => {
    if (next) {
      setPlacement('right')
    }
    setOpen(next)
    onOpenChange?.(next)
  }
  const trigger = (
    <PopoverTrigger asChild>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        disabled={disabled}
        aria-label={translate('agentPicker.configure', 'Configure {{agent}}', {
          agent: entry.label
        })}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={setupKeyDown}
      >
        <ChevronRight />
      </Button>
    </PopoverTrigger>
  )
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      {renderAnchor ? (
        <PopoverAnchor asChild ref={anchor}>
          {renderAnchor(trigger)}
        </PopoverAnchor>
      ) : (
        trigger
      )}
      <PopoverContent
        ref={content}
        side={placement}
        sticky="always"
        align="start"
        sideOffset={6}
        className="w-96 min-w-64 max-w-(--radix-popover-content-available-width) max-h-(--radix-popover-content-available-height) overflow-y-auto scrollbar-sleek"
        onClick={(event) => event.stopPropagation()}
      >
        <AgentLaunchSetupPanel
          key={`${entry.ownerKey}:${entry.agent}`}
          entry={entry}
          initial={initial}
          disabled={disabled}
          onUse={(draft) => {
            onUse(draft)
            changeOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
