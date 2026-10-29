import type { StateCreator, StoreApi } from 'zustand'
import { SESSION_SOURCE_FIELDS, type SessionSourceDiscovery } from '../lib/session-source-fields'
import {
  SESSION_SOURCE_RECEIPT,
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
              // SAFETY: the private symbol is owned by the typed source-edit boundary.
              let receipt = Reflect.get(requested, SESSION_SOURCE_RECEIPT) as
                | SessionSourceDiscovery
                | undefined
              const unreported = SESSION_SOURCE_FIELDS.filter(
                (field) =>
                  (replace || Object.hasOwn(requested, field)) &&
                  (Reflect.get(state, field) !== Reflect.get(requested, field) ||
                    Object.hasOwn(state, field) !== Object.hasOwn(requested, field)) &&
                  !receipt?.changes.has(field)
              )
              if (unreported.length) {
                if (development) {
                  throw new Error(`Unreported session source write: ${unreported.join(', ')}`)
                }
                receipt = { changes: new Map(unreported.map((field) => [field, null])), full: true }
              }
              const prepared = prepare ? prepare(state, requested) : requested
              // SAFETY: editor middleware composes receipts through the same typed operations.
              currentReceipt = receipt?.full
                ? receipt
                : ((Reflect.get(prepared, SESSION_SOURCE_RECEIPT) as
                    | SessionSourceDiscovery
                    | undefined) ?? receipt)
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
