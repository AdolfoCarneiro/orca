import { getIntlLocale } from './i18n'

type CachedFormatter<T> = { locale: string; formatter: T }

const dateTimeFormats = new WeakMap<object, CachedFormatter<Intl.DateTimeFormat>>()
const numberFormats = new WeakMap<object, CachedFormatter<Intl.NumberFormat>>()
const collators = new WeakMap<object, CachedFormatter<Intl.Collator>>()

// Module-level formatters would freeze the language active at import; key by options object and rebuild on switches.
function cachedFormatter<T>(
  cache: WeakMap<object, CachedFormatter<T>>,
  options: object,
  create: (locale: string) => T
): T {
  const locale = getIntlLocale()
  const cached = cache.get(options)
  if (cached?.locale === locale) {
    return cached.formatter
  }
  const formatter = create(locale)
  cache.set(options, { locale, formatter })
  return formatter
}

export function uiDateTimeFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cachedFormatter(
    dateTimeFormats,
    options,
    (locale) => new Intl.DateTimeFormat(locale, options)
  )
}

export function uiNumberFormat(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cachedFormatter(numberFormats, options, (locale) => new Intl.NumberFormat(locale, options))
}

export function uiCollator(options: Intl.CollatorOptions): Intl.Collator {
  return cachedFormatter(collators, options, (locale) => new Intl.Collator(locale, options))
}
