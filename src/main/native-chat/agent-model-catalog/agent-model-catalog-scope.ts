import { homedir } from 'node:os'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-record'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import type {
  AgentModelCatalogService,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import { agentModelCatalogScopeFingerprint } from './agent-model-catalog-fingerprint'
import {
  independentAgentModelCatalog,
  type AgentModelCatalogLookup,
  type AgentModelCatalogResolvedProbe
} from './agent-model-catalog-discovery'
import { sessionWorkspacePath, type AgentModelCatalogRecord } from './agent-model-catalog-workspace'

/** Discovery follows launch configuration, never session picks. */
export async function resolveAgentModelCatalogScope(
  deps: AgentModelCatalogServiceDeps,
  params: Parameters<AgentModelCatalogService['read']>[0],
  record: AgentModelCatalogRecord | undefined,
  base: string,
  home: AgentSessionAccountHome | null,
  isCurrent: () => boolean = () => true
): Promise<{
  base: string
  fingerprint: string
  exact: boolean
  cwd?: string
  resolved?: AgentModelCatalogResolvedProbe
} | null> {
  if (!isCurrent()) {
    return null
  }
  if (!independentAgentModelCatalog(params.agent) || !home) {
    return { base, fingerprint: base, exact: false }
  }
  if (record && !isNativeLocalLocation(record.location)) {
    return { base, fingerprint: base, exact: false }
  }
  const probe = deps.probes?.[params.agent]
  const savedOnly = () => params.savedOnly || !!(record && !deps.getRecord(record.sessionId))
  if (params.legacy) {
    const fingerprint = agentModelCatalogScopeFingerprint(base, 'legacy-account')
    const resolved =
      !isCurrent() || savedOnly() || !deps.store.probeDue(fingerprint)
        ? null
        : await probe?.resolveLegacy?.(home).catch(() => null)
    return {
      base,
      fingerprint,
      exact: false,
      ...(resolved ? { resolved } : {})
    }
  }
  const cwd =
    params.workspacePath === null
      ? null
      : (params.workspacePath ?? (record ? await sessionWorkspacePath(deps, record) : homedir()))
  if (!cwd) {
    return { base, fingerprint: base, exact: false }
  }
  if (!isCurrent()) {
    return null
  }
  const resolve = (lookup: AgentModelCatalogLookup) =>
    isCurrent() ? probe?.resolve?.(home, cwd, lookup).catch(() => null) : null
  const scopeKey = (resolved: AgentModelCatalogResolvedProbe | null | undefined) =>
    agentModelCatalogScopeFingerprint(base, cwd, resolved?.identity)
  let resolved = await resolve(savedOnly() ? 'saved' : 'snapshot')
  // Rerun shells only for reads due to list; saved-only reads must remain passive.
  if (isCurrent() && !savedOnly() && (!resolved || deps.store.probeDue(scopeKey(resolved)))) {
    resolved = await resolve('recover')
  }
  if (!isCurrent() || (probe?.resolve && !resolved)) {
    return null
  }
  return {
    base,
    fingerprint: scopeKey(resolved),
    exact: true,
    cwd,
    ...(resolved ? { resolved } : {})
  }
}
