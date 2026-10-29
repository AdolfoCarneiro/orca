import { z } from 'zod'

// Older hosts strip `background`; older clients omit it and keep near-live reads.
export const ComputerPermissionsStatusParams = z.object({ background: z.boolean().optional() })

export const ComputerCapabilitiesParams = z.object({})
