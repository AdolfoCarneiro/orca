import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareDottedVersions } from '../orcad/native-host-abi'

export type MacOSHelperSystemCompatibility = {
  compatible: boolean
  currentVersion: string
  minimumVersion: string
}

const SYSTEM_VERSION_PLIST_PATH = '/System/Library/CoreServices/SystemVersion.plist'

const compatibilityByHelperAppPath = new Map<string, MacOSHelperSystemCompatibility>()

export function getMacOSComputerUseHelperCompatibility(
  helperAppPath: string
): MacOSHelperSystemCompatibility | null {
  const cached = compatibilityByHelperAppPath.get(helperAppPath)
  if (cached) {
    return cached
  }
  const currentVersion = readCurrentMacOSVersion()
  const minimumVersion = readPlistVersion(
    join(helperAppPath, 'Contents', 'Info.plist'),
    'LSMinimumSystemVersion'
  )
  if (!currentVersion || !minimumVersion) {
    return null
  }
  const compatibility = {
    compatible: compareDottedVersions(currentVersion, minimumVersion) >= 0,
    currentVersion,
    minimumVersion
  }
  compatibilityByHelperAppPath.set(helperAppPath, compatibility)
  return compatibility
}

export function clearMacOSComputerUseHelperCompatibilityCache(): void {
  compatibilityByHelperAppPath.clear()
}

export function formatMacOSComputerUseHelperUnavailableReason(
  compatibility: MacOSHelperSystemCompatibility
): string {
  return `Orca Computer Use requires macOS ${compatibility.minimumVersion} or newer (this Mac is running macOS ${compatibility.currentVersion})`
}

function readCurrentMacOSVersion(): string | null {
  // The computer sidecar runs as plain Node, where Electron's getSystemVersion is absent.
  const electronVersion = process.getSystemVersion?.()
  if (electronVersion && isDottedVersion(electronVersion)) {
    return electronVersion
  }
  return readPlistVersion(SYSTEM_VERSION_PLIST_PATH, 'ProductVersion')
}

// Both plists are XML: the helper's is written by build-computer-macos.mjs, SystemVersion.plist ships as XML.
function readPlistVersion(plistPath: string, key: string): string | null {
  let source: string
  try {
    source = readFileSync(plistPath, 'utf8')
  } catch {
    return null
  }
  const version = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(source)?.[1]
  return version && isDottedVersion(version) ? version : null
}

function isDottedVersion(version: string): boolean {
  return /^\d+(?:\.\d+)*$/.test(version)
}
