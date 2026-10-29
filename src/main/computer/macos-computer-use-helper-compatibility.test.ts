import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearMacOSComputerUseHelperCompatibilityCache,
  formatMacOSComputerUseHelperUnavailableReason,
  getMacOSComputerUseHelperCompatibility
} from './macos-computer-use-helper-compatibility'

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }))

const helperAppPath = '/Applications/Orca Computer Use.app'

function mockPlists({ system, helper }: { system: string; helper: string }): void {
  vi.mocked(readFileSync).mockImplementation((path) =>
    path === '/System/Library/CoreServices/SystemVersion.plist'
      ? `<dict>\n\t<key>ProductVersion</key>\n\t<string>${system}</string>\n</dict>`
      : `<dict>\n  <key>LSMinimumSystemVersion</key>\n  <string>${helper}</string>\n</dict>`
  )
}

describe('macOS Computer Use helper compatibility', () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReset()
    clearMacOSComputerUseHelperCompatibilityCache()
  })

  it('reports an installed helper whose minimum exceeds the current OS', () => {
    mockPlists({ system: '13.6.9', helper: '14.0' })

    const result = getMacOSComputerUseHelperCompatibility(helperAppPath)

    expect(result).toEqual({
      compatible: false,
      currentVersion: '13.6.9',
      minimumVersion: '14.0'
    })
    expect(formatMacOSComputerUseHelperUnavailableReason(result!)).toBe(
      'Orca Computer Use requires macOS 14.0 or newer (this Mac is running macOS 13.6.9)'
    )
  })

  it('accepts a helper whose minimum matches the current OS', () => {
    mockPlists({ system: '12.0', helper: '12.0' })

    expect(getMacOSComputerUseHelperCompatibility(helperAppPath)?.compatible).toBe(true)
  })

  it('does not classify unreadable metadata as a known incompatibility', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('unreadable')
    })

    expect(getMacOSComputerUseHelperCompatibility(helperAppPath)).toBeNull()
  })

  it('caches successful compatibility metadata for the immutable helper app', () => {
    mockPlists({ system: '12.7.6', helper: '12.0' })

    getMacOSComputerUseHelperCompatibility(helperAppPath)
    getMacOSComputerUseHelperCompatibility(helperAppPath)

    expect(readFileSync).toHaveBeenCalledTimes(2)
  })
})
