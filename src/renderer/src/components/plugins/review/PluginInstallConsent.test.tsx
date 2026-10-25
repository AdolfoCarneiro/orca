// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginInstallConsent } from './PluginInstallConsent'

afterEach(cleanup)

function renderConsent(
  worker: boolean,
  capabilities: { kind: string; description: string }[] = []
): void {
  render(
    <PluginInstallConsent
      name="Demo"
      mode="install"
      trust={{ worker, declarative: false, panel: !worker }}
      capabilities={capabilities}
      shortcuts={[]}
      installed={null}
      official={false}
      publisher="samples"
      changed={false}
      error={null}
    />
  )
}

describe('PluginInstallConsent', () => {
  it('says that updates to a full-access plugin can change what its code does', () => {
    renderConsent(true)
    expect(screen.getByText(/can change what its full-access code does/)).toBeTruthy()
  })

  it('keeps the plain update line for plugins without full access', () => {
    renderConsent(false)
    expect(screen.queryByText(/full-access code/)).toBeNull()
  })

  it('never lists terminal access a panel cannot use, but keeps it for a worker', () => {
    const asked = [
      { kind: 'notifications:show', description: 'notifications:show' },
      { kind: 'terminal:send', description: 'terminal:send' }
    ]
    renderConsent(false, asked)
    expect(screen.queryByText(/Type and run commands/)).toBeNull()
    expect(screen.getByText(/Show desktop notifications/)).toBeTruthy()
    cleanup()
    renderConsent(true, asked)
    expect(screen.getByText(/Type and run commands/)).toBeTruthy()
  })
})
