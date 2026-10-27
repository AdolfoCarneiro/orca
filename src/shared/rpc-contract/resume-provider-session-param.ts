import { z } from 'zod'

export const ResumeProviderSessionParam = z.object({
  key: z.enum(['session_id', 'conversation_id']),
  id: z.string().min(1).max(512),
  transcriptPath: z.string().min(1).max(32_768).optional(),
  cwd: z.string().max(32768).optional(),
  effort: z.string().optional()
})
