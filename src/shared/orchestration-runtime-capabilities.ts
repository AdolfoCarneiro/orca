export const ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY = 'orchestration.federation.v1' as const
export const ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY =
  'orchestration.federation-control-mail.v1' as const
export const ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY =
  'orchestration.federation-lifecycle-settlement.v1' as const
export const ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY =
  'orchestration.worker-stop-verdict.v1' as const
export const ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY =
  'orchestration.worker-launch-preferences.v1' as const
export const ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY =
  'orchestration.federation-structured-read.v1' as const
export const ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY =
  'orchestration.federation-fleet-snapshot.v1' as const
export const ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY =
  'orchestration.federation-release-archive.v1' as const
/** Settled workers release after a grace period; retain and reuse forward to the execution host. */
export const ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY =
  'orchestration.worker-auto-release.v1' as const
/** A client that reports when the user opens or watches a finished worker's chat; any client without it keeps chat workers on manual release. */
export const ORCHESTRATION_WORKER_CHAT_TOUCH_CLIENT_CAPABILITY =
  'orchestration.worker-chat-touch.v1' as const
export const ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION = 2 as const
export const ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION = 3 as const
export const ORCHESTRATION_CONTRACT_VERSION = 1 as const
export const ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY = 'orchestration.contract.v1' as const

export const ORCHESTRATION_RUNTIME_CAPABILITIES = [
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY
] as const
