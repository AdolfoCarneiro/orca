// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { buildPluginPanelShellHtml } from './plugin-panel-shell'

describe('buildPluginPanelShellHtml', () => {
  it('removes WebRTC peer connections before plugin code can reach them', () => {
    const html = buildPluginPanelShellHtml('<main>Plugin</main>')
    const script = html.match(/<script>\n([\s\S]*?)<\/script>/)?.[1]
    Object.assign(window, { RTCPeerConnection: class {}, webkitRTCPeerConnection: class {} })
    // Configurable only so happy-dom can tear down; the iframe copy stays locked.
    window.eval(script!.replaceAll('configurable: false', 'configurable: true'))

    expect(window.eval('typeof RTCPeerConnection')).toBe('undefined')
    expect(window.eval('typeof webkitRTCPeerConnection')).toBe('undefined')
    window.eval('RTCPeerConnection = function () {}')
    expect(window.eval('typeof RTCPeerConnection')).toBe('undefined')
  })

  it('cancels anchor and form default navigation in the fallback path', () => {
    const html = buildPluginPanelShellHtml('<main>Plugin</main>')
    const script = html.match(/<script>\n([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    // Keep happy-dom's global removable for Vitest teardown; production shell
    // keeps the override non-configurable inside the disposable iframe.
    window.eval(script!.replaceAll('configurable: false', 'configurable: true'))

    const anchor = document.createElement('a')
    anchor.href = 'https://example.com/'
    document.body.appendChild(anchor)
    const clickAccepted = anchor.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    )
    const form = document.createElement('form')
    document.body.appendChild(form)
    const submitAccepted = form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )

    expect(clickAccepted).toBe(false)
    expect(submitAccepted).toBe(false)
    expect(window.open('https://example.com/')).toBeNull()
  })
})
