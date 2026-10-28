import { startGitHubWorkItemWrite } from '@/lib/github-work-item-writes'
import { useCallback, useRef, useState } from 'react'
import { useMountedRef } from './useMountedRef'

/** Track loading/errors and optimistic patches for immediate mutations; deduplicate keys already in flight. */
export function useImmediateMutation() {
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  const pendingRef = useRef(pendingKeys)
  const mountedRef = useMountedRef()
  pendingRef.current = pendingKeys

  const isPending = useCallback((key: string) => pendingKeys.has(key), [pendingKeys])

  const run = useCallback(
    async <T>(
      key: string,
      opts: {
        writeKey?: string
        mutate: () => Promise<T>
        onOptimistic?: () => void
        onSuccess?: (result: T) => void
        onRevert?: () => void
        onError?: (error: string) => void
      }
    ) => {
      if (pendingRef.current.has(key)) {
        return
      }
      const finishWrite = opts.writeKey ? startGitHubWorkItemWrite(opts.writeKey) : () => {}
      setPendingKeys((prev) => new Set(prev).add(key))
      try {
        opts.onOptimistic?.()
        const result = await opts.mutate()
        const asResult = result as { ok?: boolean; error?: string }
        if (asResult && asResult.ok === false) {
          opts.onRevert?.()
          opts.onError?.(asResult.error ?? 'Update failed')
        } else {
          opts.onSuccess?.(result)
        }
      } catch (err) {
        opts.onRevert?.()
        opts.onError?.(err instanceof Error ? err.message : 'Update failed')
      } finally {
        finishWrite()
        if (mountedRef.current) {
          setPendingKeys((prev) => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
        }
      }
    },
    [mountedRef]
  )

  return { isPending, run }
}
