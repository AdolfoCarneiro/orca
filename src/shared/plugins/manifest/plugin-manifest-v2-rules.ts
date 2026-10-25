import type { RefinementCtx } from 'zod'
import type { PluginCapability } from '../plugin-capabilities'
import { pluginExecutionAllows, type PluginExecutionProfile } from '../plugin-execution-profile'
import { pluginCapabilityReachable } from '../plugin-capability-reach'

type V2RuleSubject = {
  execution: PluginExecutionProfile
  pluginApi?: number
  capabilities: readonly PluginCapability[]
}

/** Format 2 rules that are not about shape. */
export function validatePluginManifestV2Rules(manifest: V2RuleSubject, ctx: RefinementCtx): void {
  if (
    manifest.pluginApi !== undefined &&
    !pluginExecutionAllows(manifest.execution, 'sandboxed-ui')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['pluginApi'],
      message: `${manifest.execution} plugins never call the host API; remove pluginApi`
    })
  }
  manifest.capabilities.forEach((capability, index) => {
    if (!pluginCapabilityReachable(capability.kind, manifest.execution)) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', index, 'kind'],
        message: `${capability.kind} needs the trusted-worker execution profile; ${manifest.execution} plugins can't use it, so remove it or add a worker`
      })
    }
  })
}
