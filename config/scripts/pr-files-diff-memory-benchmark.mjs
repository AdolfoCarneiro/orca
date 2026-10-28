import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const checkout = resolve(process.argv[2] ?? process.cwd())
const viewCount = Number(process.argv[3] ?? 20)
if (typeof global.gc !== 'function') {
  throw new Error('Run this benchmark with node --expose-gc')
}
const require = createRequire(join(checkout, 'package.json'))
const { build } = require('esbuild')
const temporaryRoot = process.env.TMPDIR ?? tmpdir()
await mkdir(temporaryRoot, { recursive: true })
const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'pr-files-memory-'))
const outputPath = join(temporaryDirectory, 'probe.cjs')
const persistencePath = join(
  checkout,
  'src/renderer/src/components/pull-request-page/files/view-restore.ts'
)
const cachePath = join(
  checkout,
  'src/renderer/src/components/pull-request-page/cache/files-diff-view.ts'
)
try {
  await build({
    stdin: {
      contents: `
        import React, { act, useRef } from 'react'
        import { createRoot } from 'react-dom/client'
        import { Window } from 'happy-dom'
        import { usePRFilesDiffViewPersistence } from ${JSON.stringify(persistencePath)}
        import { prFilesDiffViewStateCache, prFilesDiffScrollTopCache } from ${JSON.stringify(cachePath)}
        const browser = new Window()
        globalThis.window = browser
        globalThis.document = browser.document
        Object.defineProperty(globalThis, 'navigator', { value: browser.navigator, configurable: true })
        globalThis.IS_REACT_ACT_ENVIRONMENT = true
        function Probe({ sections, viewKey }) {
          usePRFilesDiffViewPersistence({
            sections, entriesLength: sections.length, viewStateKey: viewKey,
            entrySignature: viewKey, sectionHeights: { 0: 600, 1: 700 },
            sideBySide: true, fileTreeCollapsed: true, activeTreeSectionKey: 'file-1',
            loadedIndicesRef: useRef(new Set(sections.map((_, index) => index))),
            scrollContainerRef: useRef(null), pendingRestoreScrollTopRef: useRef(null)
          })
          return null
        }
        function visit(viewKey, sections) {
          const host = document.createElement('div')
          document.body.appendChild(host)
          const root = createRoot(host)
          act(() => root.render(<Probe sections={sections} viewKey={viewKey} />))
          act(() => root.unmount())
          host.remove()
        }
        export function warm() {
          visit('warm', [])
          prFilesDiffViewStateCache.clear()
          prFilesDiffScrollTopCache.clear()
        }
        export function run(count) {
          for (let viewIndex = 0; viewIndex < count; viewIndex++) {
            const sections = Array.from({ length: 2 }, (_, sectionIndex) => {
              const originalContent = Buffer.alloc(750_000, 65 + viewIndex % 26).toString('ascii')
              const modifiedContent = Buffer.alloc(750_000, 97 + sectionIndex).toString('ascii')
              return {
                key: 'file-' + sectionIndex, path: 'src/file-' + sectionIndex + '.ts',
                status: 'modified', added: 1, removed: 1, originalContent, modifiedContent,
                collapsed: false, loading: false, dirty: false, largeDiffRenderLimit: null,
                diffResult: { kind: 'text', originalContent, modifiedContent,
                  originalIsBinary: false, modifiedIsBinary: false }
              }
            })
            prFilesDiffScrollTopCache.set('pr-' + viewIndex, 100 + viewIndex)
            visit('pr-' + viewIndex, sections)
          }
        }
        export function inspect() {
          let characters = 0
          let loadedSections = 0
          let metadataEntries = 0
          for (const [key, view] of prFilesDiffViewStateCache) {
            if (view.sections.length === 2 && view.sectionHeights[1] === 700 && view.sideBySide &&
                view.fileTreeCollapsed && view.activeTreeSectionKey === 'file-1' &&
                view.scrollTop === 100 + Number(key.slice(3))) metadataEntries++
            for (const section of view.sections) {
              characters += section.originalContent.length + section.modifiedContent.length
              if (section.diffResult?.originalContent !== section.originalContent)
                characters += section.diffResult?.originalContent.length ?? 0
              if (section.diffResult?.modifiedContent !== section.modifiedContent)
                characters += section.diffResult?.modifiedContent.length ?? 0
              if (!section.loading) loadedSections++
            }
          }
          return { entries: prFilesDiffViewStateCache.size, metadataEntries, characters, loadedSections }
        }
      `,
      resolveDir: checkout,
      loader: 'tsx'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: outputPath,
    alias: { '@': join(checkout, 'src/renderer/src') },
    plugins: [
      {
        name: 'checkout-packages',
        setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, (args) => {
            if (args.path.startsWith('@/')) {
              return null
            }
            return { path: require.resolve(args.path), external: true }
          })
        }
      }
    ]
  })
  const probe = require(outputPath)
  async function collect() {
    for (let index = 0; index < 5; index++) {
      global.gc()
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
  }
  probe.warm()
  await collect()
  const before = process.memoryUsage()
  probe.run(viewCount)
  await collect()
  const after = process.memoryUsage()
  console.log(
    JSON.stringify({
      checkout,
      viewCount,
      ...probe.inspect(),
      heapDelta: after.heapUsed - before.heapUsed,
      externalDelta: after.external - before.external,
      node: process.version,
      platform: process.platform
    })
  )
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
