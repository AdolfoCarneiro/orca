import {
  AI_VAULT_SESSION_DRAG_TYPE,
  AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES,
  writeAiVaultSessionDragData,
  type AiVaultSessionDragPayload
} from './ai-vault-session-drag'
import {
  preparedAiVaultDragStartup,
  type AiVaultLocalDragPayload
} from './ai-vault-session-drag-startup'
import { encodeLocalDragValues, decodeLocalDragValues } from './ai-vault-local-drag-values'
import { measureClipboardTextByteLength } from '../../../shared/clipboard-text'
import { sha256 } from './sha256'

export const AI_VAULT_LOCAL_DRAG_TYPE = 'application/x-orca-ai-vault-local-resume'

function parentBinding(raw: string) {
  return Array.from(sha256(new TextEncoder().encode(raw)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
function withinLimit(raw: string) {
  return (
    raw.length <= AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES &&
    !measureClipboardTextByteLength(raw, {
      stopAfterBytes: AI_VAULT_SESSION_DRAG_PAYLOAD_MAX_BYTES
    }).exceededLimit
  )
}

export function writeAiVaultLocalDragData(
  transfer: DataTransfer,
  payload: AiVaultLocalDragPayload
) {
  transfer.setData(AI_VAULT_LOCAL_DRAG_TYPE, '')
  const { realHomeStartup, ...normal } = payload
  const prepared = {
    ...preparedAiVaultDragStartup(normal),
    ...(realHomeStartup ? { realHomeStartup: preparedAiVaultDragStartup(realHomeStartup) } : {})
  }
  writeAiVaultSessionDragData(transfer, prepared)
  const raw = transfer.getData(AI_VAULT_SESSION_DRAG_TYPE)
  if (!raw || payload.sessionExecutionHostId !== 'local' || payload.structuredSession) {
    return
  }
  const descriptor = encodeLocalDragValues(
    parentBinding(raw),
    { ...normal, agent: payload.agent },
    realHomeStartup ? { ...realHomeStartup, agent: payload.agent } : undefined
  )
  if (!descriptor) {
    return
  }
  const serialized = JSON.stringify(descriptor)
  // Oversized local intent keeps the existing prepared path; the parent item is never enlarged.
  if (withinLimit(serialized)) {
    transfer.setData(AI_VAULT_LOCAL_DRAG_TYPE, serialized)
  }
}

/** Only the existing same-local target owner calls this, before creating pending startup. */
export function readAiVaultLocalDragData(
  transfer: DataTransfer,
  parent: AiVaultSessionDragPayload
) {
  const raw = transfer.getData(AI_VAULT_LOCAL_DRAG_TYPE)
  const prepared = transfer.getData(AI_VAULT_SESSION_DRAG_TYPE)
  if (!raw || !prepared || !withinLimit(raw)) {
    return null
  }
  try {
    return decodeLocalDragValues(JSON.parse(raw), parent, parentBinding(prepared))
  } catch {
    return null
  }
}
