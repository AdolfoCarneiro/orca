import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forgetActionIconCache, resolveActionIconDataUrl } from './browser-extension-action-icon'
import type { BrowserExtensionActionIcon } from './browser-extension-action-state'

function icon(path: string): BrowserExtensionActionIcon {
  return { kind: 'path', paths: { 32: path } }
}

function dataUrl(bytes: string | Buffer): string {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : bytes
  return `data:image/png;base64,${buffer.toString('base64')}`
}

describe('action file icon cache', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-action-icon-cache-'))
  })

  afterEach(() => {
    forgetActionIconCache(root)
    rmSync(root, { recursive: true, force: true })
  })

  it('shares pending reads and cached bytes until the extension unloads', async () => {
    writeFileSync(join(root, 'icon.png'), 'old')
    const pending = resolveActionIconDataUrl(root, icon('icon.png'))
    expect(resolveActionIconDataUrl(root, icon('icon.png'))).toBe(pending)
    await expect(pending).resolves.toBe(dataUrl('old'))
    writeFileSync(join(root, 'icon.png'), 'new')
    await expect(resolveActionIconDataUrl(root, icon('icon.png'))).resolves.toBe(dataUrl('old'))
    forgetActionIconCache(root)
    await expect(resolveActionIconDataUrl(root, icon('icon.png'))).resolves.toBe(dataUrl('new'))
  })

  it('evicts old paths at capacity while preserving a recently used icon', async () => {
    for (let index = 0; index < 128; index++) {
      writeFileSync(join(root, `${index}.png`), String(index))
      await resolveActionIconDataUrl(root, icon(`${index}.png`))
    }
    await resolveActionIconDataUrl(root, icon('0.png'))
    writeFileSync(join(root, '128.png'), '128')
    await resolveActionIconDataUrl(root, icon('128.png'))
    writeFileSync(join(root, '0.png'), 'new0')
    writeFileSync(join(root, '1.png'), 'new1')

    await expect(resolveActionIconDataUrl(root, icon('0.png'))).resolves.toBe(dataUrl('0'))
    await expect(resolveActionIconDataUrl(root, icon('1.png'))).resolves.toBe(dataUrl('new1'))
  })

  it('evicts encoded image payloads before reaching the entry limit', async () => {
    for (let index = 0; index < 20; index++) {
      const bytes = Buffer.alloc(200 * 1024, index)
      writeFileSync(join(root, `${index}.png`), bytes)
      await expect(resolveActionIconDataUrl(root, icon(`${index}.png`))).resolves.toBe(
        dataUrl(bytes)
      )
    }
    writeFileSync(join(root, '0.png'), 'fresh')
    await expect(resolveActionIconDataUrl(root, icon('0.png'))).resolves.toBe(dataUrl('fresh'))
  })

  it('bounds failed path entries as well as successful file reads', async () => {
    for (let index = 0; index < 129; index++) {
      await expect(resolveActionIconDataUrl(root, icon(`${index}.png`))).resolves.toBeNull()
    }
    writeFileSync(join(root, '0.png'), 'now present')
    await expect(resolveActionIconDataUrl(root, icon('0.png'))).resolves.toBe(
      dataUrl('now present')
    )
  })

  it('preserves pending read sharing when a burst exceeds retention capacity', async () => {
    const reads = Array.from({ length: 129 }, (_, index) => {
      writeFileSync(join(root, `${index}.png`), String(index))
      return resolveActionIconDataUrl(root, icon(`${index}.png`))
    })
    expect(resolveActionIconDataUrl(root, icon('0.png'))).toBe(reads[0])
    const results = await Promise.all(reads)
    expect(results).toEqual(Array.from({ length: 129 }, (_, index) => dataUrl(String(index))))
  })

  it('does not let a pending read replace the cache owner after unload', async () => {
    writeFileSync(join(root, 'icon.png'), 'bytes')
    const old = resolveActionIconDataUrl(root, icon('icon.png'))
    forgetActionIconCache(root)
    const current = resolveActionIconDataUrl(root, icon('icon.png'))
    expect(current).not.toBe(old)
    await expect(Promise.all([old, current])).resolves.toEqual([dataUrl('bytes'), dataUrl('bytes')])
    expect(resolveActionIconDataUrl(root, icon('icon.png'))).toBe(current)
  })

  it('forgets only the unloaded extension directory', async () => {
    const neighbor = mkdtempSync(join(tmpdir(), 'orca-action-icon-cache-'))
    try {
      writeFileSync(join(root, 'icon.png'), 'one')
      writeFileSync(join(neighbor, 'icon.png'), 'two')
      await resolveActionIconDataUrl(root, icon('icon.png'))
      await resolveActionIconDataUrl(neighbor, icon('icon.png'))
      writeFileSync(join(root, 'icon.png'), 'fresh one')
      writeFileSync(join(neighbor, 'icon.png'), 'fresh two')
      forgetActionIconCache(root)
      await expect(resolveActionIconDataUrl(root, icon('icon.png'))).resolves.toBe(
        dataUrl('fresh one')
      )
      await expect(resolveActionIconDataUrl(neighbor, icon('icon.png'))).resolves.toBe(
        dataUrl('two')
      )
    } finally {
      forgetActionIconCache(neighbor)
      rmSync(neighbor, { recursive: true, force: true })
    }
  })
})
