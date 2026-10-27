import { z } from 'zod'
import { AGENT_PERMISSION_CHOICES } from '../../../shared/tui-agent-permission-choice'
import { AgentTerminalResumeParam } from '../../../shared/rpc-contract/agent-terminal-resume-params'
import { getAiVaultAgentProviderSession } from './ai-vault-resume-command'
import { isResumableTuiAgent } from '../../../shared/agent-session-resume'
import type { AgentTerminalResume } from '../../../shared/agent-terminal-resume'
import type { AiVaultSessionDragPayload } from './ai-vault-session-drag'
import type { AiVaultResumeDragStartup } from './ai-vault-session-drag-startup'

const text = z.union([
  z.object({ ref: z.enum(['command', 'agentCommand', 'agentArgs']) }).strict(),
  z.object({ literal: z.number().int().nonnegative() }).strict()
])
const envRef = z.enum(['env', 'agentEnv'])
const env = z.union([
  z.object({ ref: envRef }).strict(),
  z
    .object({
      entries: z.record(
        z.string(),
        z.union([
          z.object({ ref: envRef }).strict(),
          z.object({ literal: z.number().int().nonnegative() }).strict()
        ])
      )
    })
    .strict()
])
const alternative = z
  .object({
    command: text.optional(),
    args: text.optional(),
    env: env.optional(),
    permission: z.enum(AGENT_PERMISSION_CHOICES).optional(),
    permissionOverride: z.enum(AGENT_PERMISSION_CHOICES).optional(),
    commandOverride: text.nullable().optional(),
    agentArgs: text.nullable().optional(),
    fallback: text
  })
  .strict()
const localDragDescriptor = z
  .object({
    version: z.literal(1),
    parent: z.string().regex(/^[0-9a-f]{64}$/),
    literals: z.array(z.string()),
    normal: alternative,
    realHome: alternative.optional()
  })
  .strict()
type Text = z.infer<typeof text>
type Env = z.infer<typeof env>
type Alternative = z.infer<typeof alternative>
type Prepared = NonNullable<AiVaultSessionDragPayload['realHomeStartup']>

function textFields(startup: Prepared) {
  return {
    command: startup.command,
    agentCommand: startup.launchConfig?.agentCommand,
    agentArgs: startup.launchConfig?.agentArgs
  }
}
function envFields(startup: Prepared) {
  return { env: startup.env, agentEnv: startup.launchConfig?.agentEnv }
}
function sameEnv(a: Record<string, string> | undefined, b: Record<string, string>) {
  return (
    a !== undefined &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(b).every(([key, value]) => Object.hasOwn(a, key) && a[key] === value)
  )
}

export function encodeLocalDragValues(
  parent: string,
  normal: AiVaultResumeDragStartup,
  realHome?: AiVaultResumeDragStartup
) {
  const literals: string[] = []
  const indices = new Map<string, number>()
  const literal = (value: string) => {
    let index = indices.get(value)
    if (index === undefined) {
      index = literals.length
      indices.set(value, index)
      literals.push(value)
    }
    return { literal: index }
  }
  function encode(startup: AiVaultResumeDragStartup): Alternative | undefined {
    const recipe = startup.resume?.recipe
    if (
      recipe?.source !== 'current-inputs' ||
      !startup.localFallback ||
      !isResumableTuiAgent(startup.agent)
    ) {
      return
    }
    const agent = startup.agent
    function encodeText(value: string): Text {
      const fields = textFields(startup)
      for (const ref of ['command', 'agentCommand', 'agentArgs'] as const) {
        if (fields[ref] === value) {
          return { ref }
        }
      }
      return literal(value)
    }
    function encodeEnv(value: Record<string, string>): Env {
      const fields = envFields(startup)
      for (const ref of ['env', 'agentEnv'] as const) {
        if (sameEnv(fields[ref], value)) {
          return { ref }
        }
      }
      const entries = Object.entries(value).map(([key, entry]) => {
        for (const ref of ['env', 'agentEnv'] as const) {
          if (Object.hasOwn(fields[ref] ?? {}, key) && fields[ref]?.[key] === entry) {
            return [key, { ref }] as const
          }
        }
        return [key, literal(entry)] as const
      })
      return { entries: Object.fromEntries(entries) }
    }
    const settings = recipe.settings
    const command = settings.agentCmdOverrides?.[agent]
    const args = settings.agentDefaultArgs?.[agent]
    const selectedEnv = settings.agentDefaultEnv?.[agent]
    return {
      ...(command !== undefined ? { command: encodeText(command) } : {}),
      ...(args !== undefined ? { args: encodeText(args) } : {}),
      ...(selectedEnv !== undefined ? { env: encodeEnv(selectedEnv) } : {}),
      ...(settings.agentPermissionDefault !== undefined
        ? { permission: settings.agentPermissionDefault }
        : {}),
      ...(settings.agentPermissionOverrides?.[agent] !== undefined
        ? { permissionOverride: settings.agentPermissionOverrides[agent] }
        : {}),
      ...(recipe.commandOverride !== undefined
        ? {
            commandOverride:
              recipe.commandOverride === null ? null : encodeText(recipe.commandOverride)
          }
        : {}),
      ...(recipe.agentArgs !== undefined
        ? { agentArgs: recipe.agentArgs === null ? null : encodeText(recipe.agentArgs) }
        : {}),
      fallback: encodeText(startup.localFallback.command)
    }
  }
  const first = encode(normal)
  if (!first) {
    return null
  }
  return {
    version: 1 as const,
    parent,
    normal: first,
    ...(realHome ? { realHome: encode(realHome) } : {}),
    literals
  }
}

export function decodeLocalDragValues(
  value: unknown,
  parent: AiVaultSessionDragPayload,
  binding: string
): { normal: AiVaultResumeDragStartup; realHome?: AiVaultResumeDragStartup } | null {
  const parsed = localDragDescriptor.safeParse(value)
  if (!parsed.success || parsed.data.parent !== binding) {
    return null
  }
  const descriptor = parsed.data
  if (descriptor.realHome && !parent.realHomeStartup) {
    return null
  }
  const providerSession = getAiVaultAgentProviderSession({
    agent: parent.agent,
    sessionId: parent.sessionId,
    filePath: parent.sessionFilePath
  })
  if (!providerSession) {
    return null
  }
  function decode(
    selected: Alternative,
    startup: Prepared,
    realHome: boolean
  ): AiVaultResumeDragStartup {
    function readText(encoded: Text): string {
      const value =
        'ref' in encoded ? textFields(startup)[encoded.ref] : descriptor.literals[encoded.literal]
      if (value === undefined) {
        throw new Error('Missing drag value')
      }
      return value
    }
    function readEnv(encoded: Env): Record<string, string> {
      const fields = envFields(startup)
      if ('ref' in encoded) {
        const value = fields[encoded.ref]
        if (!value) {
          throw new Error('Missing drag env')
        }
        return { ...value }
      }
      return Object.fromEntries(
        Object.entries(encoded.entries).map(([key, ref]) => {
          const value =
            'ref' in ref
              ? Object.hasOwn(fields[ref.ref] ?? {}, key)
                ? fields[ref.ref]?.[key]
                : undefined
              : descriptor.literals[ref.literal]
          if (value === undefined) {
            throw new Error('Missing drag env entry')
          }
          return [key, value]
        })
      )
    }
    const agent = parent.agent
    const resume: AgentTerminalResume = {
      providerSession,
      recipe: {
        source: 'current-inputs',
        settings: {
          ...(selected.command !== undefined
            ? { agentCmdOverrides: { [agent]: readText(selected.command) } }
            : {}),
          ...(selected.args !== undefined
            ? { agentDefaultArgs: { [agent]: readText(selected.args) } }
            : {}),
          ...(selected.env !== undefined
            ? { agentDefaultEnv: { [agent]: readEnv(selected.env) } }
            : {}),
          ...(selected.permission !== undefined
            ? { agentPermissionDefault: selected.permission }
            : {}),
          ...(selected.permissionOverride !== undefined
            ? { agentPermissionOverrides: { [agent]: selected.permissionOverride } }
            : {})
        },
        ...(selected.commandOverride !== undefined
          ? {
              commandOverride:
                selected.commandOverride === null ? null : readText(selected.commandOverride)
            }
          : {}),
        ...(selected.agentArgs !== undefined
          ? { agentArgs: selected.agentArgs === null ? null : readText(selected.agentArgs) }
          : {})
      },
      resumeInLaunchCwd: true,
      ...(agent === 'omp' && parent.sessionFilePath
        ? { ompResumeFilePath: parent.sessionFilePath }
        : {}),
      ...(agent === 'codex' && (realHome || parent.codexHome !== undefined)
        ? { codexHome: realHome ? null : parent.codexHome }
        : {})
    }
    if (!AgentTerminalResumeParam.safeParse(resume).success) {
      throw new Error('Invalid drag recipe')
    }
    const command = readText(selected.fallback)
    if (!command.trim()) {
      throw new Error('Missing fallback command')
    }
    return {
      command,
      resume,
      ...(startup.envToDelete ? { envToDelete: startup.envToDelete } : {})
    }
  }
  try {
    return {
      normal: decode(descriptor.normal, parent, false),
      ...(descriptor.realHome && parent.realHomeStartup
        ? { realHome: decode(descriptor.realHome, parent.realHomeStartup, true) }
        : {})
    }
  } catch {
    return null
  }
}
