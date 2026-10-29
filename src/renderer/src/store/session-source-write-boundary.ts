import type { StateCreator, StoreApi } from 'zustand'
import {
  SESSION_SOURCE_FIELDS,
  SESSION_SOURCE_KINDS,
  type SessionSourceDiscovery
} from '../lib/session-source-fields'
import {
  SESSION_SOURCE_RECEIPT,
  readSessionSourceReceipt,
  type SessionSourceSet,
  type SessionSourceWrite
} from './session-source-edits'

type SourceApi<S> = Omit<S, 'setState'> & {
  setState: S extends StoreApi<infer T> ? SessionSourceSet<T> : never
  getSessionSourceReceipt(): SessionSourceDiscovery | undefined
}

declare module 'zustand/vanilla' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Zustand's mutator registry must merge with the library interface.
  interface StoreMutators<S, A> {
    'orca/session-source': SourceApi<S> & { readonly sessionSourceOptions?: A }
  }
}

export type SessionStateCreator<T, Slice = T> = StateCreator<
  T,
  [['orca/session-source', never]],
  [],
  Slice
>

export function replaceSessionSourceFields<S extends object>(
  partial: S
): S & SessionSourceWrite<S> {
  return Object.assign({}, partial, {
    [SESSION_SOURCE_RECEIPT]: {
      changes: new Map(SESSION_SOURCE_FIELDS.map((field) => [field, null])),
      full: true
    }
  })
}

/** The fixed-field gate is the only compatibility fallback for an unreported write. */
export function withSessionSourceWrites<T extends object>(
  createState: SessionStateCreator<T>,
  development = import.meta.env.DEV,
  reconcile?: (api: StoreApi<T>) => (state: T, requested: T | Partial<T>) => T | Partial<T>
): StateCreator<T, [], [['orca/session-source', never]]> {
  const initialize: StateCreator<T, [], []> = (set, get, api) => {
    const prepare = reconcile?.(api)
    let currentReceipt: SessionSourceDiscovery | undefined
    Object.assign(api, { getSessionSourceReceipt: () => currentReceipt })
    const wrap = (write: typeof set): typeof set => {
      const wrapped = (
        partial: T | Partial<T> | ((state: T) => T | Partial<T>),
        replace?: boolean
      ): void => {
        const previousReceipt = currentReceipt
        try {
          // SAFETY: replacement callers supply a complete root; the wrapper retains their flag.
          ;(write as (partial: (state: T) => T | Partial<T>, replace?: boolean) => void)(
            (state) => {
              const requested = typeof partial === 'function' ? partial(state) : partial
              if (requested === state) {
                return state
              }
              const prepared = prepare ? prepare(state, requested) : requested
              let receipt = readSessionSourceReceipt(prepared)
              const changes = new Map(receipt?.changes)
              const unreported: string[] = []
              for (const field of SESSION_SOURCE_FIELDS) {
                if (
                  !(replace || Object.hasOwn(prepared, field)) ||
                  (Reflect.get(state, field) === Reflect.get(prepared, field) &&
                    Object.hasOwn(state, field) === Object.hasOwn(prepared, field))
                ) {
                  continue
                }
                if (SESSION_SOURCE_KINDS[field] === 'field') {
                  changes.set(field, null)
                } else if (!changes.has(field)) {
                  unreported.push(field)
                  changes.set(field, null)
                }
              }
              if (unreported.length && development) {
                throw new Error(`Unreported session source write: ${unreported.join(', ')}`)
              }
              receipt = { ...receipt, changes, full: Boolean(receipt?.full || unreported.length) }
              currentReceipt = receipt
              const next = { ...prepared }
              Reflect.deleteProperty(next, SESSION_SOURCE_RECEIPT)
              return Object.keys(next).length ? next : state
            },
            replace
          )
        } finally {
          // Synchronous nested writes restore the outer notification's receipt.
          currentReceipt = previousReceipt
        }
      }
      // SAFETY: one implementation forwards both Zustand replacement overloads unchanged.
      return wrapped as typeof set
    }
    api.setState = wrap(api.setState)
    // SAFETY: the source API and gate are installed above before this initializer receives them.
    const sourceStateCreator = createState as StateCreator<T, [], []>
    return sourceStateCreator(wrap(set), get, api)
  }
  // SAFETY: initialize installs the source API before any slice or subscriber can access it.
  return initialize as StateCreator<T, [], [['orca/session-source', never]]>
}
