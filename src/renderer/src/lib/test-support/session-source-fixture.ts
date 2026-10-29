import type { StoreApi } from 'zustand'
import {
  editSessionSource,
  unwrapSessionSourceWrite,
  type SessionSourcePartial,
  type SessionSourceSet,
  type SessionSourceEdit,
  type SessionSourceWrite,
  type OrdinarySourcePartial
} from '../../store/session-source-edits'
import { replaceSessionSourceFields } from '../../store/session-source-write-boundary'

export type SessionTestStore<S> = Omit<StoreApi<S>, 'setState'> & { setState: SessionSourceSet<S> }

type FixtureStore<S> = { getState(): S; setState: SessionSourceSet<S> }

/** Fixture ingress explicitly replaces source fields; actions still use the production boundary. */
export function setSessionTestState<S extends object>(
  store: FixtureStore<S>,
  partial:
    | Partial<S>
    | SessionSourceWrite<S>
    | ((state: S) => Partial<S> | SessionSourceWrite<S> | undefined),
  replace?: false
): void
export function setSessionTestState<S extends object>(
  store: FixtureStore<S>,
  partial: S | SessionSourceWrite<S>,
  replace: true
): void
export function setSessionTestState<S extends object>(
  store: FixtureStore<S>,
  partial:
    | Partial<S>
    | SessionSourceWrite<S>
    | ((state: S) => Partial<S> | SessionSourceWrite<S> | undefined),
  replace?: boolean
): void {
  const next = typeof partial === 'function' ? partial(store.getState()) : partial
  if (next === undefined) {
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture ingress admits raw source fields through the same explicit replacement boundary.
  const data = unwrapSessionSourceWrite<S>(next as SessionSourcePartial<S>)
  const accepted = data.receipt
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the boundary returns a receipt only for an already-opaque accepted write.
      (next as SessionSourceWrite<S>)
    : replaceSessionSourceFields<S>(data.partial, 'hydration')
  if (replace) {
    // SAFETY: the replacement overload requires a complete root, just like the store setter.
    store.setState(accepted, true)
  } else {
    store.setState(accepted)
  }
}

/** Exercises an edit-taking production helper against a test root. */
export function sessionTestEdit<S extends object>(
  state: S,
  apply: (edit: SessionSourceEdit<S>) => OrdinarySourcePartial<S>
): SessionSourceWrite<S> {
  const edit = editSessionSource(state)
  return edit.finish(apply(edit))
}
