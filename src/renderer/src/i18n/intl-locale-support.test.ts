import { describe, expect, it, vi } from 'vitest'
import { supportedIntlLocale } from './intl-locale-support'
import { DEFAULT_LOCALE } from './supported-languages'

describe('supportedIntlLocale', () => {
  it('caches the default fallback for a normally unsupported locale', () => {
    const supportedLocalesOf = vi.fn(() => [])
    const provider = { supportedLocalesOf }

    expect(supportedIntlLocale('zz-ZZ', provider)).toBe(DEFAULT_LOCALE)
    expect(supportedIntlLocale('zz-ZZ', provider)).toBe(DEFAULT_LOCALE)
    expect(supportedLocalesOf).toHaveBeenCalledTimes(1)
  })

  it('keeps providers with the same method separate and preserves their receiver', () => {
    function supportedLocalesOf(this: { locale: string }): string[] {
      return [this.locale]
    }
    const german = { locale: 'de', supportedLocalesOf }
    const french = { locale: 'fr', supportedLocalesOf }

    expect(supportedIntlLocale('requested', german)).toBe('de')
    expect(supportedIntlLocale('requested', french)).toBe('fr')
    expect(supportedIntlLocale('requested', german)).toBe('de')
  })

  it('refreshes support results when a provider method is replaced or restored', () => {
    const unsupported = (): string[] => []
    const provider = { supportedLocalesOf: unsupported }

    expect(supportedIntlLocale('de', provider)).toBe(DEFAULT_LOCALE)
    provider.supportedLocalesOf = () => ['de']
    expect(supportedIntlLocale('de', provider)).toBe('de')
    provider.supportedLocalesOf = unsupported
    expect(supportedIntlLocale('de', provider)).toBe(DEFAULT_LOCALE)
  })

  it('retries a thrown check so a recovering provider can support the locale', () => {
    const supportedLocalesOf = vi
      .fn(() => ['de'])
      .mockImplementationOnce(() => {
        throw new Error('provider not ready')
      })
    const provider = { supportedLocalesOf }

    expect(supportedIntlLocale('de', provider)).toBe(DEFAULT_LOCALE)
    expect(supportedIntlLocale('de', provider)).toBe('de')
    expect(supportedIntlLocale('de', provider)).toBe('de')
    expect(supportedLocalesOf).toHaveBeenCalledTimes(2)
  })
})
