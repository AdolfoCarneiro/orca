import type {
  AgentModelCatalogSessionAccess,
  AgentModelCatalogStore
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentModelCatalogContext } from '../native-chat/agent-model-catalog/agent-model-catalog-service-contract'
import type {
  CodexStructuredSessionAdapterDeps,
  CodexStructuredLaunch
} from './codex-structured-session-state'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'

export function codexAcquireCatalogAccess(
  deps: Pick<
    CodexStructuredSessionAdapterDeps,
    'modelCatalog' | 'readModelCatalog' | 'demandModelCatalog'
  >,
  launch: Pick<CodexStructuredLaunch, 'codexHome'>,
  sessionId?: string,
  context?: AgentModelCatalogContext
): CodexSessionCatalogAccess | undefined {
  const access = agentModelCatalogSessionAccess(
    deps.modelCatalog,
    CODEX_STRUCTURED_AGENT,
    launch.codexHome
  )
  const demand = deps.demandModelCatalog
  return access && sessionId
    ? {
        ...access,
        ...(deps.readModelCatalog
          ? {
              read: (verifiedOnly?: boolean) =>
                deps.readModelCatalog?.(sessionId, verifiedOnly, context) ?? null
            }
          : {}),
        ...(demand ? { demand: (legacy?: boolean) => demand(sessionId, legacy, context) } : {})
      }
    : access
}

export type CodexSessionCatalogAccess = AgentModelCatalogSessionAccess & {
  read?: (verifiedOnly?: boolean) => ReturnType<AgentModelCatalogStore['get']>
  demand?: (legacy?: boolean) => Promise<unknown>
}
