// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { PluginCardArt } from './PluginCardArt'

function drawn(tintKey: string): string {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() =>
    root.render(
      <PluginCardArt types={['app-theme']} fileType={null} palettes={[]} tintKey={tintKey} />
    )
  )
  const html = container.innerHTML
  act(() => root.unmount())
  return html
}

describe('PluginCardArt', () => {
  it('draws different fallback art for two themes without pictures or colours', () => {
    const keys = [
      'stablyai.orca-midnight-theme',
      'stablyai.orca-dusk-ember',
      'stablyai.orca-nord-theme',
      'stablyai.orca-oled-theme'
    ]
    const art = keys.map(drawn)
    expect(new Set(art).size).toBe(keys.length)
    // Stable per plugin, so a card and its page hero match.
    expect(drawn('stablyai.orca-midnight-theme')).toBe(art[0])
  })
})
