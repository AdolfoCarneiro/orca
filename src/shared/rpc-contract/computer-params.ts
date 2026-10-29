import { z } from 'zod'

// Older hosts strip `fresh`; older clients omit it and get the backed-off read.
export const ComputerPermissionsStatusParams = z.object({ fresh: z.boolean().optional() })

export const ComputerCapabilitiesParams = z.object({})
