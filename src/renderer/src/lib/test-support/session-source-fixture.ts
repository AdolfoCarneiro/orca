import type { SessionSourceSet } from '../../store/session-source-edits'
import { replaceSessionSourceFields } from '../../store/session-source-write-boundary'

type FixtureStore<S> = { getState(): S; setState: SessionSourceSet<S> }

/** Fixture ingress explicitly replaces source fields; actions still use the production boundary. */
export function setSessionTestState<S extends object>(
  store: FixtureStore<S>,
  partial: Partial<S> | ((state: S) => Partial<S>),
  replace?: false
): void
export function setSessionTestState<S extends object>(
  store: FixtureStore<S>,
  partial: S,
  replace: true
): void
export function setSessionTestState<S extends object>(
  store: FixtureStore<S>,
  partial: Partial<S> | ((state: S) => Partial<S>),
  replace?: boolean
): void {
  const next = typeof partial === 'function' ? partial(store.getState()) : partial
  if (replace) {
    // SAFETY: the replacement overload requires a complete root, just like the store setter.
    store.setState(replaceSessionSourceFields(next as S), true)
  } else {
    store.setState(replaceSessionSourceFields(next))
  }
}
