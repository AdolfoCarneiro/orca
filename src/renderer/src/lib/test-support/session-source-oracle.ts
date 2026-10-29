import { expect } from 'vitest'
import type { AppState } from '../../store/types'
import type { SessionSourceDiscovery } from '../session-source-fields'
import { discoverSessionSources } from './session-source-discovery'

type SourceTestStore = {
  subscribe(listener: (after: AppState, before: AppState) => void): () => void
  getSessionSourceReceipt(): SessionSourceDiscovery | undefined
}

let oracleDepth = 0
export function isSessionSourceOracleActive(): boolean {
  return oracleDepth > 0
}

/** Every test-store notification is checked independently of the producer and projection. */
export function observeSessionSourceOracle(store: SourceTestStore): () => void {
  return store.subscribe((after, before) => {
    oracleDepth++
    try {
      const receipt = store.getSessionSourceReceipt()
      const native = discoverSessionSources(before, after)
      expect(receipt, 'accepted write has a source receipt').toBeDefined()
      if (receipt?.full) {
        expect(
          receipt.fullBoundary,
          'full boundaries require explicit replacement or order authority'
        ).toBeOneOf(['replacement', 'order'])
        if (receipt.fullBoundary === 'replacement') {
          expect(
            [...receipt.changes.values()].some((keys) => keys === null),
            'replacement names its complete domain'
          ).toBe(true)
        }
      } else {
        expect(native.full, 'native order changes require a full boundary').toBe(false)
      }
      for (const [field, keys] of native.changes) {
        expect(receipt?.changes.has(field), `missing source field: ${field}`).toBe(true)
        const reported = receipt?.changes.get(field)
        if (reported === null) {
          continue
        }
        if (keys === null) {
          expect(reported, field).toBeNull()
        } else {
          for (const key of keys) {
            expect(reported?.has(key), `missing source address: ${field}/${key}`).toBe(true)
          }
        }
        const sequences = Reflect.get(native.sequences ?? {}, field)
        if (sequences && keys) {
          for (const key of keys) {
            expect(
              Reflect.get(receipt?.sequences ?? {}, field)?.get(key) ?? [],
              `${field}/${key} occurrences`
            ).toEqual(sequences.get(key) ?? [])
          }
        }
      }
    } finally {
      oracleDepth--
    }
  })
}
