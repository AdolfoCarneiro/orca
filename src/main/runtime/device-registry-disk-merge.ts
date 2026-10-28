import { writeDurableSecureJsonFile, writeSecureJsonFile } from '../../shared/secure-file'
import type { DeviceEntry } from './device-entry'
import { readDeviceRegistryFile, type DeviceRegistryFileRead } from './device-registry-file-read'

/**
 * What a save may write over the file as it is now on disk. Another writer (an admin removing a
 * device, the pairing CLI adding one) may have changed it since this process loaded it, so:
 * - a row this process knew of that is gone from disk stays gone, never resurrected from memory;
 * - rows this save adds, and this save's version of rows still on disk, are kept;
 * - rows that appeared on disk since, and that this save didn't remove, are kept too.
 */
export function mergeDeviceRegistrySave(
  before: readonly DeviceEntry[],
  next: readonly DeviceEntry[],
  disk: DeviceRegistryFileRead
): DeviceEntry[] {
  const known = new Set(before.map((device) => device.deviceId))
  const onDisk = new Set(disk.devices.map((device) => device.deviceId))
  const saving = new Set(next.map((device) => device.deviceId))
  return [
    ...next.filter((device) => onDisk.has(device.deviceId) || !known.has(device.deviceId)),
    ...disk.devices.filter((device) => !known.has(device.deviceId) && !saving.has(device.deviceId))
  ]
}

/**
 * Re-reads the file and writes `next` merged over it (atomically, through the secure-file stage and
 * rename). A file that became unreadable or corrupt proves nothing about removals, so then `next`
 * is written as is, as before. Returns what was written. Security transitions pass `durable`.
 */
export function writeMergedDeviceRegistry(
  registryPath: string,
  before: readonly DeviceEntry[],
  next: readonly DeviceEntry[],
  options: { durable?: boolean } = {}
): DeviceEntry[] {
  const disk = readDeviceRegistryFile(registryPath)
  const merged =
    disk.unreadable || disk.corruptFilePending
      ? [...next]
      : mergeDeviceRegistrySave(before, next, disk)
  const write = options.durable ? writeDurableSecureJsonFile : writeSecureJsonFile
  write(registryPath, merged)
  return merged
}
