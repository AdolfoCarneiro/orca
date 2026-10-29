import { DEFAULT_LOCALE } from './supported-languages'

type IntlLocaleProvider = { supportedLocalesOf(locale: string): string[] }
type IntlLocaleCache = {
  supportedLocalesOf: IntlLocaleProvider['supportedLocalesOf']
  locales: Map<string, string>
}

const INTL_LOCALE_CACHE_LIMIT = 32
const supportedLocales = new WeakMap<IntlLocaleProvider, IntlLocaleCache>()

export function supportedIntlLocale(locale: string, intl: IntlLocaleProvider): string {
  try {
    const supportedLocalesOf = intl.supportedLocalesOf
    let cache = supportedLocales.get(intl)
    if (!cache || cache.supportedLocalesOf !== supportedLocalesOf) {
      cache = { supportedLocalesOf, locales: new Map() }
      supportedLocales.set(intl, cache)
    }
    const cached = cache.locales.get(locale)
    if (cached !== undefined) {
      return cached
    }
    // An unsupported tag would silently use the runtime locale; explicitly fall back to the default.
    const supported = supportedLocalesOf.call(intl, locale)[0] ?? DEFAULT_LOCALE
    if (cache.locales.size >= INTL_LOCALE_CACHE_LIMIT) {
      cache.locales.clear()
    }
    cache.locales.set(locale, supported)
    return supported
  } catch {
    // A provider may recover without changing identity; retry thrown checks on the next call.
    return DEFAULT_LOCALE
  }
}
