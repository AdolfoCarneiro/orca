import type { AutomationRun } from '../../../../shared/automations-types'
import { getAutomationRunContent as getSharedAutomationRunContent } from '../../../../shared/automation-run-content'
import { translate } from '@/i18n/i18n'

export function getAutomationRunContent(run: AutomationRun): string {
  return getSharedAutomationRunContent(
    run,
    translate('auto.components.automations.runContent.noOutput', 'No output content available.')
  )
}
