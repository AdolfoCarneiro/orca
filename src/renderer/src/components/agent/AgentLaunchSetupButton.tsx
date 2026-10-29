import { useState, type KeyboardEvent } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
  disabled,
  mode,
  onOpenChange,
  onUse
}: {
  entry: AgentPickerEntry
  initial?: AgentPickerDraft
  disabled?: boolean
  mode?: 'launch' | 'select'
  onOpenChange?: (open: boolean) => void
  onUse: (draft: AgentPickerDraft) => void
}) {
  const [open, setOpen] = useState(false)
  const changeOpen = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }
  return (
    <Popover open={open} onOpenChange={changeOpen}>
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
      <PopoverContent
        side="right"
        align="start"
        className="w-auto"
        onClick={(event) => event.stopPropagation()}
      >
        <AgentLaunchSetupPanel
          key={`${entry.ownerKey}:${entry.agent}`}
          entry={entry}
          initial={initial}
          mode={mode}
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
