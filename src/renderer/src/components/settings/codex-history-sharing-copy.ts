import { translate } from '@/i18n/i18n'

export function getCodexHistorySharingTitle(): string {
  return translate(
    'settings.agents.codexHistorySharing.title',
    'Share Codex history across accounts'
  )
}

export function getCodexHistorySharingDescription(): string {
  return translate(
    'settings.agents.codexHistorySharing.description',
    "Lets each Codex account, and your own ~/.codex, resume conversations started on the others. Turn off to keep every account's history separate. Turning it off removes nothing already shared."
  )
}

export function getCodexHistorySharingUnsupported(host: string): string {
  return translate(
    'settings.agents.codexHistorySharing.unsupported',
    'Update Orca on {{host}} to change this setting there.',
    { host }
  )
}

export function getCodexHistorySharingUpdateFailed(host: string): string {
  return translate(
    'settings.agents.codexHistorySharing.updateFailed',
    'Could not update the setting on {{host}}.',
    { host }
  )
}
