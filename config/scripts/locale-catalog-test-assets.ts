import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizePath, type Plugin } from 'vite'

export function localeCatalogTestAssets(): Plugin {
  const directory = fileURLToPath(new URL('../../src/renderer/src/i18n/locales/', import.meta.url))
  const filesById = new Map<string, string>()
  const idsByPath = new Map<string, string>()
  for (const filename of readdirSync(directory)) {
    if (/^[A-Za-z-]+\.json$/.test(filename)) {
      const id = `\0locale-catalog-test-assets:${filename}.js`
      const file = join(directory, filename)
      filesById.set(id, file)
      idsByPath.set(`${normalizePath(file)}?url`, id)
    }
  }
  return {
    name: 'locale-catalog-test-assets',
    enforce: 'pre',
    resolveId(source, importer) {
      if (filesById.has(source)) {
        return source
      }
      if (!source.endsWith('.json?url')) {
        return null
      }
      const file = importer ? resolve(dirname(importer.split('?')[0]), source) : source
      return idsByPath.get(normalizePath(file)) ?? null
    },
    load(id) {
      const file = filesById.get(id)
      if (!file) {
        return null
      }
      // Virtual modules retain real fetch(data:) parsing without exposing files outside the test root.
      const catalog = readFileSync(file).toString('base64')
      return `export default ${JSON.stringify(`data:application/json;base64,${catalog}`)}`
    }
  }
}
