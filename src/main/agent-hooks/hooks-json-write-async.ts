import { randomUUID } from 'node:crypto'
import {
  lstat,
  realpath,
  mkdir,
  readFile,
  writeFile,
  stat,
  chmod,
  copyFile,
  rename,
  rm
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export type NativeHookDestination = {
  path: string
  parent: { dev: string; ino: string }
}

export async function writeHooksJsonAsync(
  configPath: string,
  config: Record<string, unknown>,
  options?: {
    serialized?: string
    privateMode?: boolean
    beforePublish?: (destination: NativeHookDestination) => Promise<void>
  }
): Promise<void> {
  const link = await lstat(configPath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  const writePath = link?.isSymbolicLink() ? await realpath(configPath) : configPath
  const serialized = options?.serialized ?? `${JSON.stringify(config, null, 2)}\n`
  const original = await readFile(writePath, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  const beforePublish = async () => {
    if (!options?.beforePublish) {
      return
    }
    await mkdir(dirname(writePath), { recursive: true })
    const parent = await realpath(dirname(writePath))
    const identity = await stat(parent, { bigint: true })
    if (!identity.isDirectory() || identity.ino <= 0n || identity.dev <= 0n) {
      throw new Error('Could not identify settings publication parent')
    }
    await options.beforePublish({
      path: join(parent, basename(writePath)),
      parent: { dev: String(identity.dev), ino: String(identity.ino) }
    })
  }
  if (original === serialized) {
    await beforePublish()
    if (options?.privateMode && process.platform !== 'win32') {
      await chmod(writePath, 0o600)
    }
    return
  }
  await mkdir(dirname(writePath), { recursive: true })
  const mode = options?.privateMode
    ? 0o600
    : original !== null
      ? (await stat(writePath)).mode & 0o777
      : 0o600
  const tmp = `${writePath}.${randomUUID()}.tmp`
  const backup = `${writePath}.bak`
  const backupTmp = `${backup}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, serialized, { mode, flag: 'wx' })
    if (process.platform !== 'win32') {
      await chmod(tmp, mode)
    }
    if (original !== null) {
      const backupLink = await lstat(backup).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null
        }
        throw error
      })
      if (backupLink?.isSymbolicLink()) {
        throw new Error(`Refusing to overwrite symlinked backup: ${backup}`)
      }
      await copyFile(writePath, backupTmp)
      if (options?.privateMode && process.platform !== 'win32') {
        await chmod(backupTmp, 0o600)
      }
      await rename(backupTmp, backup)
    }
    await beforePublish()
    await rename(tmp, writePath)
  } finally {
    await Promise.all([rm(tmp, { force: true }), rm(backupTmp, { force: true })])
  }
}
