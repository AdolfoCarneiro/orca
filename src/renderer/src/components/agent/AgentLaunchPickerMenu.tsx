import { useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { AgentLaunchSetupButton } from './AgentLaunchSetupButton'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import { chatUnavailableLabel } from '../tab-bar/tab-agent-row-presentation'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch-picker-rows'
import {
  searchAgentPickerSetups,
  type AgentPickerDraft,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'

export function pickerLaunchRow(
  entry: AgentPickerEntry,
  surface: AgentPickerSurface
): NewTabAgentMenuRow {
  return {
    agent: entry.agent,
    kind: surface === 'chat' ? 'chat' : 'cli',
    executionHostId: entry.rows[0]?.executionHostId
  }
}

type Launch = (row: NewTabAgentMenuRow, draft?: AgentPickerDraft, entry?: AgentPickerEntry) => void

export function AgentLaunchPickerMenu({
  model,
  disabled,
  setupDisabled,
  runLaunch,
  entries,
  hideSearch,
  mode,
  value,
  onSelectAgent
}: {
  model: NewTabAgentMenuModel
  disabled?: boolean
  setupDisabled?: boolean
  runLaunch: Launch
  entries: AgentPickerEntry[]
  hideSearch?: boolean
  mode?: 'launch' | 'select'
  value?: AgentPickerDraft
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
}) {
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const shortcut = useOptionalShortcutLabel('tab.newAgent')
  const setups = searchAgentPickerSetups(entries, query)
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const visible = entries.filter((entry) =>
    words.every((word) => `${entry.agent} ${entry.label}`.toLowerCase().includes(word))
  )
  return (
    <div ref={root} data-agent-launch-picker="true">
      {!hideSearch ? (
        <div className="p-1">
          <Input
            value={query}
            autoFocus
            placeholder={translate('agentPicker.search', 'Search agents and setups…')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                return
              }
              event.stopPropagation()
              if (event.key === 'Enter' || event.key === 'ArrowDown') {
                event.preventDefault()
                const first = root.current?.querySelector<HTMLElement>(
                  '[role="menuitem"]:not([data-disabled])'
                )
                if (event.key === 'Enter') {
                  first?.click()
                } else {
                  first?.focus()
                }
              }
            }}
          />
        </div>
      ) : null}
      {setups.map((setup) => (
        <AgentPickerMenuRow
          key={`${setup.entry.agent}:${setup.model.id}:${setup.choices.options?.effort ?? ''}`}
          entry={setup.entry}
          mode={mode}
          label={setup.label}
          initial={{
            agent: setup.entry.agent,
            surface: setup.entry.defaultSurface,
            choices: setup.choices
          }}
          onSelectAgent={onSelectAgent}
          disabled={disabled || setupDisabled}
          setupDisabled={setupDisabled}
          runLaunch={runLaunch}
        />
      ))}
      {visible.map((entry) => (
        <AgentPickerMenuRow
          key={entry.agent}
          entry={entry}
          mode={mode}
          selected={value?.agent === entry.agent ? value : undefined}
          disabled={disabled}
          setupDisabled={setupDisabled}
          runLaunch={runLaunch}
          onSelectAgent={onSelectAgent}
          shortcut={
            mode !== 'select' && model.state === 'settled' && model.defaultTuiAgent === entry.agent
              ? (shortcut ?? undefined)
              : undefined
          }
        />
      ))}
      {!visible.length && !setups.length ? (
        <DropdownMenuItem disabled>
          {translate(
            'auto.components.agent.AgentCombobox.579c768bde',
            'No agents match your search.'
          )}
        </DropdownMenuItem>
      ) : null}
    </div>
  )
}

function AgentPickerMenuRow({
  entry,
  label = entry.label,
  initial,
  selected,
  mode,
  disabled,
  setupDisabled,
  runLaunch,
  shortcut,
  onSelectAgent
}: {
  entry: AgentPickerEntry
  label?: string
  initial?: AgentPickerDraft
  selected?: AgentPickerDraft
  mode?: 'launch' | 'select'
  setupDisabled?: boolean
  disabled?: boolean
  runLaunch: Launch
  shortcut?: string
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
}) {
  const item = useRef<HTMLDivElement>(null)
  const configured = useRef<AgentPickerDraft | undefined>(undefined)
  const unavailable = entry.rows.find((row) => row.kind === 'chat-unavailable')
  return (
    <DropdownMenuItem
      ref={item}
      variant="launch"
      disabled={disabled || !entry.surfaces.length}
      onSelect={() => {
        const draft = configured.current ?? initial
        configured.current = undefined
        const surface = draft?.surface ?? entry.defaultSurface
        const row = draft
          ? pickerLaunchRow(entry, surface)
          : (entry.rows.find((row) =>
              surface === 'chat'
                ? row.kind === 'chat'
                : row.kind === 'terminal' || row.kind === 'cli'
            ) ?? pickerLaunchRow(entry, surface))
        if (draft) {
          runLaunch(row, draft, entry)
        } else {
          runLaunch(row, undefined)
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          item.current?.querySelector<HTMLButtonElement>('button')?.focus()
        }
      }}
    >
      <AgentIcon agent={entry.agent} size={14} />
      <span className="flex-1">{label}</span>
      {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
      {unavailable?.kind === 'chat-unavailable' && !entry.surfaces.includes('chat') ? (
        <span className="text-xs text-muted-foreground">
          {chatUnavailableLabel(unavailable.reason)}
        </span>
      ) : null}
      <AgentLaunchSetupButton
        entry={entry}
        initial={initial ?? selected}
        mode={mode}
        disabled={disabled || setupDisabled}
        onOpenChange={(next) => {
          if (next) {
            onSelectAgent?.(entry.agent)
          }
        }}
        onUse={(draft) => {
          configured.current = draft
          item.current?.click()
        }}
      />
    </DropdownMenuItem>
  )
}
