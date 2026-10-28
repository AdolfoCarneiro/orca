import { useSyncExternalStore } from 'react'
import { i18n } from './i18n'
import {
  getTranslationResourceVersion,
  subscribeTranslationResourceVersion
} from './translation-resource-version'

function subscribe(onChange: () => void): () => void {
  i18n.on('languageChanged', onChange)
  const unsubscribeResources = subscribeTranslationResourceVersion(onChange)
  return () => {
    i18n.off('languageChanged', onChange)
    unsubscribeResources()
  }
}

function getRevision(): string {
  return `${i18n.language}\0${getTranslationResourceVersion()}`
}

/** Memoized components that call translate() need this to re-render on language or catalog changes. */
export function useUiLanguageRevision(): string {
  return useSyncExternalStore(subscribe, getRevision)
}
