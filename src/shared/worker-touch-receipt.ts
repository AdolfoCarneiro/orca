/** A touch reply settles the report unless the host has yet to record the worker's custody. */
export function isWorkerTouchRecorded(result: unknown): boolean {
  return !(typeof result === 'object' && result !== null && 'pending' in result && result.pending)
}
