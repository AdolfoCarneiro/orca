import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  getChatErrorEscalationDescription,
  getChatErrorEscalationTitle
} from './chat-error-escalation-copy'

type OrchestrationChatErrorSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function OrchestrationChatErrorSetting({
  settings,
  updateSettings
}: OrchestrationChatErrorSettingProps): React.JSX.Element {
  const escalationEnabled = settings.orchestrationChatErrorEscalationEnabled !== false
  return (
    <SettingsSwitchRow
      label={getChatErrorEscalationTitle()}
      description={getChatErrorEscalationDescription()}
      checked={escalationEnabled}
      ariaLabel={getChatErrorEscalationTitle()}
      onChange={() => {
        void updateSettings({ orchestrationChatErrorEscalationEnabled: !escalationEnabled })
      }}
    />
  )
}
