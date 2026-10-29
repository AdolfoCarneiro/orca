export function pushRouteDeclarationContent(value: {
  v: 1
  platform: 'ios' | 'android'
  apnsEnvironment?: 'sandbox' | 'production'
  token: string
  routeKey: string
  version: number
  hosts: readonly string[]
}): string {
  return JSON.stringify({
    ...(value.apnsEnvironment ? { apnsEnvironment: value.apnsEnvironment } : {}),
    hosts: [...new Set(value.hosts)].sort(),
    platform: value.platform,
    routeKey: value.routeKey,
    token: value.token,
    v: value.v,
    version: value.version
  })
}
