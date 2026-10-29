import { describe, expect, it, vi } from 'vitest'
import type { ClaudeSession } from './structured/claude-structured-session-state'
import { applyClaudeLivePermissionMode } from './claude-structured-live-permission'

function session(setPermissionMode: (mode: string) => Promise<void>) {
  const fake = {
    connection: { setPermissionMode: vi.fn(setPermissionMode) },
    launchIntent: { model: 'opus', permissionMode: 'auto' },
    firstRootInit: { permissionMode: 'default' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the switch reads only these three fields.
  return { fake, session: fake as unknown as ClaudeSession }
}

describe('switching a running Claude agent to a new permission mode', () => {
  it('sends the CLI mode and records that the agent now runs it', async () => {
    const { fake, session: claude } = session(async () => {})
    await expect(applyClaudeLivePermissionMode(claude, 'full-access', 1000)).resolves.toBe(true)
    expect(fake.connection.setPermissionMode).toHaveBeenCalledWith('bypassPermissions', {
      timeoutMs: 1000
    })
    expect(fake.launchIntent).toEqual({ model: 'opus', permissionMode: 'bypassPermissions' })
    expect(fake.firstRootInit).toEqual({ permissionMode: 'bypassPermissions' })
  })

  it('leaves a refused mode and own settings to the next start', async () => {
    const { fake, session: claude } = session(async () => {
      throw new Error('Cannot set permission mode to bypassPermissions')
    })
    await expect(applyClaudeLivePermissionMode(claude, 'full-access', 1000)).resolves.toBe(false)
    await expect(applyClaudeLivePermissionMode(claude, 'own', 1000)).resolves.toBe(false)
    await expect(applyClaudeLivePermissionMode(undefined, 'ask', 1000)).resolves.toBe(false)
    expect(fake.connection.setPermissionMode).toHaveBeenCalledTimes(1)
    expect(fake.launchIntent.permissionMode).toBe('auto')
  })
})
