import { z } from 'zod'
import { PushDeviceRegistrationRequestSchema } from './device-registration-messages.js'
export { pushRouteDeclarationContent } from './route-declaration-content.js'

export const PushRouteDeclarationSchema = z
  .object({
    v: z.literal(1),
    platform: z.enum(['ios', 'android']),
    apnsEnvironment: z.enum(['sandbox', 'production']).optional(),
    token: z.string().min(1).max(4096),
    routeKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    hosts: z.array(z.string().regex(/^[A-Za-z0-9_-]{16}$/)).max(100),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/)
  })
  .strict()
  .refine(
    (value) =>
      PushDeviceRegistrationRequestSchema.safeParse({
        v: 1,
        deviceId: 'route',
        platform: value.platform,
        token: value.token,
        ...(value.apnsEnvironment ? { apnsEnvironment: value.apnsEnvironment } : {})
      }).success
  )

export type PushRouteDeclaration = z.infer<typeof PushRouteDeclarationSchema>
