import { PLUGIN_V1_CAPABILITY_ALIASES } from '../plugin-capabilities'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function renameCapabilities(capabilities: unknown): unknown {
  if (!Array.isArray(capabilities)) {
    return capabilities
  }
  return capabilities.flatMap((capability) => {
    const aliases = isRecord(capability)
      ? PLUGIN_V1_CAPABILITY_ALIASES.get(String(capability.kind))
      : undefined
    return aliases ? aliases.map((kind) => ({ ...capability, kind })) : [capability]
  })
}

/** Rewrites names format 1 used into today's, so v1 manifests keep loading; v2 must use the new names. */
export function upgradePluginManifestV1Names(raw: unknown): unknown {
  if (!isRecord(raw) || raw.manifestVersion !== 1) {
    return raw
  }
  return { ...raw, capabilities: renameCapabilities(raw.capabilities) }
}
