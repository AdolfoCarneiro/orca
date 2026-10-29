import { translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import type { MobileAutomationRun } from './automation-reply-schema'

export function automationRunStatusLabel(status: string): string {
  const runStatusLabels: Record<string, string> = {
    pending: translate('automations.mobile.pending', 'Pending'),
    dispatching: translate('automations.mobile.starting', 'Starting'),
    dispatched: translate('automations.mobile.dispatched', 'Dispatched'),
    completed: translate('automations.mobile.completed', 'Completed'),
    skipped_precheck: translate('automations.mobile.skippedPrecheck', 'Skipped · precheck'),
    skipped_missed: translate(
      'automations.mobile.skippedMissedSchedule',
      'Skipped · missed schedule'
    ),
    skipped_unavailable: translate(
      'automations.mobile.skippedHostUnavailable',
      'Skipped · host unavailable'
    ),
    skipped_needs_interactive_auth: translate(
      'automations.mobile.skippedSignInNeeded',
      'Skipped · sign-in needed'
    ),
    dispatch_failed: translate('automations.mobile.couldNotStart', 'Could not start')
  }
  return runStatusLabels[status] ?? translate('automations.mobile.unknownResult', 'Unknown result')
}
export function automationDate(timestamp: number | null | undefined, timezone?: string): string {
  if (timestamp == null) {
    return translate('automations.mobile.notReported', 'Not reported')
  }
  try {
    return new Date(timestamp).toLocaleString(getUiIntlLocale(), {
      ...(timezone ? { timeZone: timezone } : {}),
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  } catch {
    return new Date(timestamp).toLocaleString(getUiIntlLocale())
  }
}
export function runMatchesOutcome(run: MobileAutomationRun, outcome: string): boolean {
  if (outcome === 'all') {
    return true
  }
  if (outcome === 'skipped') {
    return run.status.startsWith('skipped_')
  }
  if (outcome === 'active') {
    return ['pending', 'dispatching', 'dispatched'].includes(run.status)
  }
  return run.status === outcome
}
