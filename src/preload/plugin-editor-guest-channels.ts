// Why literals: the sandboxed guest preload cannot load shared chunks, so it must not import the
// shared protocol modules; plugin-editor-guests.test.ts pins these to them.
export const PLUGIN_EDITOR_GUEST_POST = 'plugin-editor-guest:post'
export const PLUGIN_EDITOR_GUEST_DELIVER = 'plugin-editor-guest:deliver'
/** Host → editor types: never relayed back, so the relay cannot echo its own deliveries. */
export const PLUGIN_EDITOR_HOST_MESSAGE_TYPES: readonly string[] = [
  'orca-editor-document',
  'orca-editor-flush',
  'orca-editor-edit-rejected',
  'orca-panel-ping',
  'orca-panel-theme'
]
