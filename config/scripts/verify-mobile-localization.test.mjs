import { describe, expect, it } from 'vitest'

import {
  collectIncompletePluralFamilies,
  collectLiveSwitchViolations
} from './verify-mobile-localization.mjs'

describe('verify-mobile-localization', () => {
  it('rejects translations that cannot follow a live language switch', () => {
    const source = [
      "const LABELS = [translate('a.b', 'Module scope')]",
      'export function Row() {',
      "  return <Text>{translate('a.c', 'Global in component')}</Text>",
      '}',
      'export const Memoized = memo(() => {',
      "  const onPress = () => Alert.alert(translate('a.d', 'Nested callback'))",
      '  return null',
      '})',
      'export function Subscribed() {',
      '  const t = useMobileTranslation()',
      "  return <Text>{t('a.e', 'Hook translator')}</Text>",
      '}',
      "export function rowLabel() { return translate('a.f', 'Helper') }"
    ].join('\n')

    expect(collectLiveSwitchViolations('mobile/src/row.tsx', source)).toEqual([
      'mobile/src/row.tsx:1 translates at module scope; translate when rendering instead',
      'mobile/src/row.tsx:3 calls translate() in a component or hook; use `const t = useMobileTranslation()`',
      'mobile/src/row.tsx:6 calls translate() in a component or hook; use `const t = useMobileTranslation()`'
    ])
  })

  it('requires every CLDR category once a locale translates a plural family', () => {
    const english = new Map([
      ['files_one', '{{count}} file'],
      ['files_other', '{{count}} files']
    ])

    expect(
      collectIncompletePluralFamilies(
        english,
        new Map([
          ['files_one', '{{count}} файл'],
          ['files_other', '{{count}} файла']
        ]),
        'ru'
      )
    ).toEqual(['files: missing _few, _many'])
    expect(
      collectIncompletePluralFamilies(english, new Map([['files_other', '{{count}} 件']]), 'ja')
    ).toEqual([])
  })
})
