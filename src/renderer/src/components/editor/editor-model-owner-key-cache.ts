import type { OpenFile } from '@/store/slices/editor'
import type { EditorBufferViewIndex } from '@/store/slices/editor/buffers/editor-buffer-views'
import {
  editorBufferRouteInputsEqual,
  editorBufferRouteInputsOf,
  type EditorBufferRouteState
} from '@/store/slices/editor/buffers/editor-buffer-identity-cache'
import { getEditorModelOwnerKey } from './editor-model-owner'

type OwnerKeyState = EditorBufferRouteState & Partial<EditorBufferViewIndex>
type OwnerKeyInputs = {
  routeInputs: ReturnType<typeof editorBufferRouteInputsOf>
  editorBufferIdOf: OwnerKeyState['editorBufferIdOf']
}

function ownerKeyInputsOf(state: OwnerKeyState): OwnerKeyInputs {
  return {
    routeInputs: editorBufferRouteInputsOf(state),
    editorBufferIdOf: state.editorBufferIdOf
  }
}

function ownerKeyInputsEqual(a: OwnerKeyInputs, b: OwnerKeyInputs): boolean {
  return (
    a.editorBufferIdOf === b.editorBufferIdOf &&
    a.routeInputs.length === b.routeInputs.length &&
    a.routeInputs.every((input, index) => input === b.routeInputs[index])
  )
}

function ownerInputsEqual(a: OwnerKeyState, b: OwnerKeyState): boolean {
  return a.editorBufferIdOf === b.editorBufferIdOf && editorBufferRouteInputsEqual(a, b)
}

function cachedOwnerKey(
  keys: WeakMap<OpenFile, string>,
  file: OpenFile,
  state: OwnerKeyState
): string {
  let key = keys.get(file)
  if (key === undefined) {
    key = getEditorModelOwnerKey(file, state)
    keys.set(file, key)
  }
  return key
}

/** Keys stay valid until an owner input changes, so a tab edit re-resolves that tab, not every tab. */
export function createEditorModelOwnerKeyCache(initialState: OwnerKeyState) {
  // The last editor can close without another lookup; do not pin its whole store snapshot.
  let keyInputs = ownerKeyInputsOf(initialState)
  let keyState = new WeakRef(initialState)
  let keys = new WeakMap<OpenFile, string>()
  const ownerKeyOf = (file: OpenFile, state: OwnerKeyState): string => {
    if (state !== keyState.deref()) {
      const inputs = ownerKeyInputsOf(state)
      if (!ownerKeyInputsEqual(inputs, keyInputs)) {
        keys = new WeakMap()
      }
      keyInputs = inputs
      keyState = new WeakRef(state)
    }
    return cachedOwnerKey(keys, file, state)
  }
  /** Resolver for `state` that never evicts the current keys, for reading a superseded state. */
  const ownerKeyReaderFor = (state: OwnerKeyState): ((file: OpenFile) => string) => {
    const stateKeys =
      state === keyState.deref() || ownerKeyInputsEqual(ownerKeyInputsOf(state), keyInputs)
        ? keys
        : new WeakMap<OpenFile, string>()
    return (file) => cachedOwnerKey(stateKeys, file, state)
  }
  return { ownerKeyOf, ownerKeyReaderFor, ownerInputsEqual }
}
