import { z } from 'zod'

export class AgentLaunchUnbuildableError extends Error {}

// Evidence covers this C1 invocation, never an earlier uncertain invocation.
export class ResumePlanNotDispatchedError extends AgentLaunchUnbuildableError {}

export const RESUME_LAUNCH_NOT_DISPATCHED = { resumeLaunchOutcome: 'not-dispatched' } as const
const refusal = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.literal('runtime_error'),
    data: z.object({ resumeLaunchOutcome: z.literal('not-dispatched') })
  })
})

export function isAgentResumeNotDispatched(error: unknown): boolean {
  return (
    error instanceof ResumePlanNotDispatchedError ||
    (typeof error === 'object' &&
      error !== null &&
      'response' in error &&
      refusal.safeParse(error.response).success)
  )
}

export function isAgentResumeNotDispatchedResponse(response: unknown): boolean {
  return refusal.safeParse(response).success
}
