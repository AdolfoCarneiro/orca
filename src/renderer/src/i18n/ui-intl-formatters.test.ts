import { afterEach, expect, it, vi } from 'vitest'
import { i18n, loadRendererUiLanguage } from './i18n'
import { uiNumberFormat } from './ui-intl-formatters'

const GROUPED: Intl.NumberFormatOptions = {}

afterEach(async () => {
  vi.restoreAllMocks()
  await i18n.changeLanguage('en')
})

it('rebuilds a shared formatter when the UI language changes', async () => {
  expect(uiNumberFormat(GROUPED).format(1234.5)).toBe('1,234.5')
  await i18n.changeLanguage(await loadRendererUiLanguage('de'))
  expect(uiNumberFormat(GROUPED).format(1234.5)).toBe('1.234,5')
})

it('reuses native locale support checks across cached formatter hits', () => {
  const dates = vi.spyOn(Intl.DateTimeFormat, 'supportedLocalesOf')
  const numbers = vi.spyOn(Intl.NumberFormat, 'supportedLocalesOf')

  for (let index = 0; index < 100; index++) {
    expect(uiNumberFormat(GROUPED).format(1234.5)).toBe('1,234.5')
  }

  expect(dates).toHaveBeenCalledTimes(1)
  expect(numbers).toHaveBeenCalledTimes(1)
})
