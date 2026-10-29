import { useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session-option-catalog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import { AgentDefaultArgsInput } from '../settings/AgentLaunchDefaultsEditor'
import { NativeChatSessionOptionRows } from '../native-chat/NativeChatSessionOptionRows'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import { AgentPermissionMenu } from '../settings/AgentPermissionChoiceControls'
import {
  agentPickerPanelArguments,
  agentPickerSpeedValue,
  editAgentPickerSpeed,
  editAgentPickerPanelText
} from '../../../../shared/agent-launch-picker-arguments'
import { agentPickerSpeedIsOpaque } from '../../../../shared/agent-launch-picker-speed'
import { editAgentPickerPermission } from '../../../../shared/agent-launch-picker-permission'
import {
  agentPickerButtonOrder,
  agentPickerArgumentsKnown,
  agentPickerDraft,
  agentPickerEffectiveChoices,
  agentPickerModels,
  agentPickerEntryOptions,
  agentPickerPermissions,
  editAgentPickerDraft,
  type AgentPickerEntry,
  type AgentPickerDraft,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'

export function AgentLaunchSetupPanel({
  entry,
  initial,
  disabled,
  mode = 'launch',
  onUse
}: {
  entry: AgentPickerEntry
  initial?: AgentPickerDraft
  disabled?: boolean
  mode?: 'launch' | 'select'
  onUse: (draft: AgentPickerDraft) => void
}) {
  const [draft, setDraft] = useState(() => initial ?? agentPickerDraft(entry))
  const [modelQuery, setModelQuery] = useState('')
  const [legacy, setLegacy] = useState(false)
  const [argumentsOpen, setArgumentsOpen] = useState(entry.defaultSurface === 'terminal')
  const argumentsKnown = agentPickerArgumentsKnown(entry, draft)
  const effective = agentPickerEffectiveChoices(entry, draft)
  const models = agentPickerModels(entry)
  const defaultsPending =
    draft.surface === 'chat' ? entry.structuredDefaultsPending : entry.defaultsPending
  const seed = getAgentSessionOptionLaunchCatalog(entry.agent)
  const listedDefaultKnown =
    entry.catalog.origin !== 'unknown' &&
    (entry.catalog.listingNamesConfiguredModel ?? seed?.hostListingNamesConfiguredModel === true)
  const currentModel =
    effective.model ??
    (!defaultsPending && listedDefaultKnown
      ? models.find((model) => model.isDefault)?.id
      : undefined)
  const modelDisabled = disabled || defaultsPending || !currentModel
  const options = agentPickerEntryOptions(entry, currentModel, draft.surface)
  const argumentsView = agentPickerPanelArguments(entry, draft, currentModel)
  const optionRows: SessionOptionDescriptor[] = options.map((option) => {
    const liveModel = models.find((model) => model.id === currentModel)
    const current =
      (option.id === 'fastMode' || option.id === 'serviceTier'
        ? agentPickerSpeedValue(entry, draft, option.id)
        : effective.options?.[option.id]) ??
      (currentModel && !defaultsPending
        ? option.kind.type === 'boolean'
          ? String(option.kind.defaultValue)
          : option.id === 'effort'
            ? liveModel?.defaultEffort
            : option.kind.defaultIsCliDefault
              ? option.kind.defaultValue
              : undefined
        : undefined)
    if (agentPickerSpeedIsOpaque(entry, draft, option.id)) {
      return {
        id: option.id,
        label: option.label,
        category: option.category,
        kind: {
          type: 'select',
          choices: [
            {
              value: 'arguments',
              label: translate('agentPicker.setByArguments', 'Set by your Arguments')
            }
          ],
          currentValue: 'arguments'
        },
        valueSource: 'default',
        transport: 'agent-session',
        settable: false
      }
    }
    return {
      id: option.id,
      label: option.label,
      category: option.category,
      kind:
        option.kind.type === 'boolean'
          ? { type: 'boolean', currentValue: current === 'true' }
          : {
              type: 'select',
              choices:
                current && !option.kind.choices.some((choice) => choice.value === current)
                  ? [...option.kind.choices, { value: current, label: current }]
                  : option.kind.choices,
              currentValue: current
            },
      valueSource: current === undefined ? 'unknown' : 'default',
      transport: 'agent-session',
      settable:
        !disabled &&
        !defaultsPending &&
        current !== undefined &&
        (!(option.id === 'fastMode' || option.id === 'serviceTier') ||
          !entry.surfaces.includes('terminal') ||
          argumentsKnown)
    }
  })
  const renderOptions = (rows: SessionOptionDescriptor[]) => (
    <NativeChatSessionOptionRows
      options={rows}
      shownReason={null}
      pendingIds={new Set()}
      onSet={(option, value) =>
        setDraft(
          option.id === 'fastMode' || option.id === 'serviceTier'
            ? editAgentPickerSpeed(entry, draft, option.id, String(value), currentModel)
            : editAgentPickerDraft(draft, { options: { [option.id]: String(value) } })
        )
      }
      onAction={() => {}}
    />
  )
  const use = (surface: AgentPickerSurface) => onUse({ ...draft, surface })
  return (
    <div
      className="w-96 max-w-full space-y-3 p-3"
      onKeyDown={(event) => {
        event.stopPropagation()
        if (
          !disabled &&
          event.key === 'Enter' &&
          (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        ) {
          event.preventDefault()
          use(entry.defaultSurface)
        }
      }}
    >
      <div className="space-y-1">
        <Label variant="settings">{translate('agentPicker.model', 'Model')}</Label>
        <Command
          density="menu"
          onKeyDownCapture={(event) => {
            if (
              !disabled &&
              event.key === 'Enter' &&
              event.currentTarget.querySelector(
                '[cmdk-item][data-selected="true"][data-current="true"]'
              )
            ) {
              event.preventDefault()
              event.stopPropagation()
              use(entry.defaultSurface)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.stopPropagation()
            }
          }}
        >
          <CommandInput
            disabled={modelDisabled}
            value={modelQuery}
            onValueChange={setModelQuery}
            aria-label={translate('agentPicker.searchModels', 'Search models')}
            placeholder={translate('agentPicker.searchModels', 'Search models')}
          />
          <CommandList className="max-h-48">
            <CommandEmpty>
              {translate('agentPicker.noModels', 'No models match your search.')}
            </CommandEmpty>
            {legacy && !modelQuery ? (
              <CommandItem value="__back__" disabled={disabled} onSelect={() => setLegacy(false)}>
                {translate('agentPicker.backModels', 'Back to current models')}
              </CommandItem>
            ) : null}
            {models
              .filter(
                (model) =>
                  !model.hidden &&
                  (model.id === currentModel || modelQuery || Boolean(model.isLegacy) === legacy)
              )
              .map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  keywords={[model.label]}
                  disabled={modelDisabled}
                  data-current={currentModel === model.id}
                  onSelect={() => setDraft(editAgentPickerDraft(draft, { model: model.id }))}
                >
                  {model.label}
                  {currentModel === model.id ? <Check className="ml-auto size-3.5" /> : null}
                </CommandItem>
              ))}
            {!legacy && !modelQuery && models.some((model) => model.isLegacy) ? (
              <CommandItem value="__legacy__" disabled={disabled} onSelect={() => setLegacy(true)}>
                {translate('agentPicker.legacyModels', 'Legacy models')}
              </CommandItem>
            ) : null}
            {currentModel && !models.some((model) => model.id === currentModel) ? (
              <CommandItem
                value={currentModel}
                disabled={modelDisabled}
                onSelect={() => {}}
                data-current="true"
              >
                {currentModel}
                <Check className="ml-auto size-3.5" />
              </CommandItem>
            ) : null}
          </CommandList>
        </Command>
      </div>
      {renderOptions(optionRows.filter((row) => row.id !== 'fastMode' && row.id !== 'serviceTier'))}
      <AgentPermissionMenu
        agentId={entry.agent}
        label={entry.label}
        layout="stacked"
        showInherited={false}
        rawValue={argumentsView.selectedPermission ? undefined : argumentsView.permission}
        disabled={
          disabled ||
          defaultsPending ||
          !argumentsView.permission ||
          (entry.surfaces.includes('terminal') && !argumentsKnown)
        }
        permission={{
          choice: argumentsView.selectedPermission ?? 'own',
          defaultChoice: argumentsView.selectedPermission ?? 'own',
          choices: agentPickerPermissions(entry.agent, draft.surface),
          source: 'agent',
          flag: '',
          argsSetPermission: false,
          onSelect: (choice) => {
            if (choice !== 'default') {
              setDraft(editAgentPickerPermission(entry, draft, choice))
            }
          }
        }}
      />
      {renderOptions(optionRows.filter((row) => row.id === 'fastMode' || row.id === 'serviceTier'))}
      {entry.surfaces.includes('terminal') ? (
        <div className="relative pl-4">
          <Collapsible open={argumentsOpen} onOpenChange={setArgumentsOpen}>
            <CollapsibleTrigger
              aria-label={translate('agentPicker.toggleArguments', 'Toggle Arguments')}
              className="absolute top-0 left-0 flex items-center"
            >
              <ChevronRight
                className={
                  argumentsOpen
                    ? 'size-3 text-muted-foreground rotate-90'
                    : 'size-3 text-muted-foreground'
                }
              />
            </CollapsibleTrigger>
            {!argumentsOpen ? (
              <Label variant="settings">{translate('agentPicker.arguments', 'Arguments')}</Label>
            ) : null}
            <CollapsibleContent>
              <AgentDefaultArgsInput
                defaultArgs={argumentsView.text}
                argsOverride={argumentsView.text}
                disabled={disabled || !argumentsKnown}
                onSaveArgs={() => {}}
                onDraftChange={(text) =>
                  setDraft(editAgentPickerPanelText(entry, draft, text, currentModel))
                }
                choiceChips={argumentsView.chips.map((chip) => ({
                  key: chip.key,
                  label: entry.label,
                  source: 'arguments',
                  flag: chip.flag,
                  onRemove: (text) => {
                    setDraft(chip.remove())
                    return text
                  }
                }))}
                note={translate('agentPicker.argumentsHint', 'Applies only to CLI launches.')}
              />
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        {mode === 'select' ? (
          <Button type="button" size="sm" disabled={disabled} onClick={() => use(draft.surface)}>
            {translate('agentPicker.use', 'Use')}
          </Button>
        ) : (
          agentPickerButtonOrder(entry).map((surface) => (
            <Button
              key={surface}
              type="button"
              size="sm"
              disabled={disabled}
              variant={surface === entry.defaultSurface ? 'default' : 'outline'}
              onClick={() => use(surface)}
            >
              {surface === 'chat'
                ? translate('agentPicker.openChat', 'Open chat')
                : translate('agentPicker.openTerminal', 'Open terminal')}
            </Button>
          ))
        )}
      </div>
    </div>
  )
}
