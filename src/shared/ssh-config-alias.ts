/** OpenSSH Host matching is case-insensitive; share normalization across picker/import/tombstone/duplicate checks. */
export function normalizeSshConfigAlias(alias: string | null | undefined): string {
  return alias ? alias.trim().toLowerCase() : ''
}

/** Host, port, case-sensitive user and route identify an endpoint; unknown hosts never match. */
export function sshEndpointIdentity(target: {
  host?: string | null
  port?: number | null
  username?: string | null
  jumpHost?: string | null
  proxyCommand?: string | null
}): string {
  const host = target.host?.trim().toLowerCase() ?? ''
  if (!host) {
    return ''
  }
  const port =
    typeof target.port === 'number' &&
    Number.isInteger(target.port) &&
    target.port >= 1 &&
    target.port <= 65_535
      ? target.port
      : 22
  return `${host}\u0000${port}\u0000${target.username?.trim() ?? ''}\u0000${target.jumpHost?.trim() ?? ''}\u0000${target.proxyCommand?.trim() ?? ''}`
}
