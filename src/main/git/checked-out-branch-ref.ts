import { gitExecFileAsync } from './runner'
import type { GitExecOptions } from './command-runner/git-exec-options'

export type CheckedOutBranchState =
  | { kind: 'symbolic'; ref: string }
  | { kind: 'detached' }
  | { kind: 'unknown' }

type CheckedOutBranchRefResult =
  | { kind: 'symbolic'; stdout: string }
  | { kind: 'detached' }
  | { kind: 'unknown' }

export async function readCheckedOutBranchRefResult(
  worktreePath: string,
  options: Omit<GitExecOptions, 'cwd'> = {}
): Promise<CheckedOutBranchRefResult> {
  try {
    const { stdout } = await gitExecFileAsync(['symbolic-ref', '--quiet', 'HEAD'], {
      ...options,
      cwd: worktreePath
    })
    return { kind: 'symbolic', stdout }
  } catch (error) {
    if (
      !options.signal?.aborted &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 1 &&
      'stdout' in error &&
      error.stdout === '' &&
      'stderr' in error &&
      error.stderr === '' &&
      (!('name' in error) || error.name !== 'AbortError') &&
      (!('signal' in error) || error.signal == null) &&
      (!('killed' in error) || error.killed !== true) &&
      (!('timedOut' in error) || error.timedOut !== true) &&
      (!('outputTruncated' in error) || error.outputTruncated !== true)
    ) {
      return { kind: 'detached' }
    }
    return { kind: 'unknown' }
  }
}

export async function readCheckedOutBranchState(
  worktreePath: string,
  options: Omit<GitExecOptions, 'cwd'> = {}
): Promise<CheckedOutBranchState> {
  const result = await readCheckedOutBranchRefResult(worktreePath, options)
  if (options.signal?.aborted) {
    return { kind: 'unknown' }
  }
  if (result.kind !== 'symbolic') {
    return result
  }
  const ref = result.stdout.replace(/\r?\n$/, '')
  if (!ref.startsWith('refs/')) {
    return { kind: 'unknown' }
  }
  for (const character of ref) {
    const code = character.charCodeAt(0)
    if (code <= 32 || code === 127 || code === 0xfffd) {
      return { kind: 'unknown' }
    }
  }
  return { kind: 'symbolic', ref }
}
