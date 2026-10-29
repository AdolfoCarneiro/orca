import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

export function getWorkerAutoReleaseTitle(): string {
  return translate(
    'auto.components.settings.OrchestrationPane.workerAutoReleaseTitle',
    'Auto-close finished workers'
  )
}

export function getWorkerAutoReleaseDescription(): string {
  return translate(
    'auto.components.settings.OrchestrationPane.workerAutoReleaseDescription',
    "Closes a worker's terminal or chat about 2 minutes after it reports done. Workers you've typed into or opened stay open."
  )
}

export function getWorkerAutoReleaseSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.orchestration.search.741dfc03fa', fallback: 'worker' },
    {
      key: 'auto.components.settings.OrchestrationPane.workerAutoReleaseKeywordClose',
      fallback: 'close'
    },
    {
      key: 'auto.components.settings.OrchestrationPane.workerAutoReleaseKeywordRelease',
      fallback: 'release'
    }
  ])
}
