import { getWslHomeAsync } from '../wsl'
import { listConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { getCachedWslHome } from '../wsl-home-cache'
import { blockedWslDistroForPath } from './wsl-unc-access-gate'

/** The distro's home for authorization; an uncached home is only probed (wsl.exe) while it runs (E9). */
export async function wslHomeUnlessStopped(distro: string): Promise<string | null> {
  if (getCachedWslHome(distro) === undefined && (await blockedWslDistroForPath('', distro))) {
    return null
  }
  return getWslHomeAsync(distro)
}

/**
 * UNC homes of distros a fresh running list confirms, never probing one that stopped since (E9).
 * A failed probe lists none: a stale "running" answer plus a cached home would hand back a root to scan.
 */
export async function listRunningWslHomeDirsUnlessStopped(): Promise<string[]> {
  const homes = await Promise.all(
    (await listConfirmedRunningWslDistros()).map((distro) => wslHomeUnlessStopped(distro))
  )
  return homes.filter((home): home is string => Boolean(home))
}
