type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

type GitConfigSnapshot = Map<string, string[]>

// Mirror config --get exit 1 for absent keys; empty success changes caller behavior.
export class GitConfigSnapshotKeyNotFoundError extends Error {
  constructor(key: string) {
    super(`git config --get found no value for '${key}'`)
    this.name = 'GitConfigSnapshotKeyNotFoundError'
  }
}

function isConfigGetCommand(args: string[], includeAllValues = false): boolean {
  return (
    args[0] === 'config' &&
    ((args.length === 3 &&
      (args[1] === '--get' || (includeAllValues && args[1] === '--get-all'))) ||
      (includeAllValues && args.length === 4 && args[1] === '--null' && args[2] === '--get-all'))
  )
}

function canonicalizeGitConfigLookupKey(key: string): string {
  const parts = key.split('.')
  if (parts.length === 1) {
    return key.toLowerCase()
  }
  const firstPart = parts[0]?.toLowerCase() ?? ''
  const lastPart = parts.at(-1)?.toLowerCase() ?? ''
  return [firstPart, ...parts.slice(1, -1), lastPart].join('.')
}

function parseGitConfigListSnapshot(stdout: string): GitConfigSnapshot {
  const snapshot: GitConfigSnapshot = new Map()
  for (const record of iterateNulDelimitedFields(stdout)) {
    if (!record.trim()) {
      continue
    }

    // Values may contain newlines; only the first separates key and value.
    const separatorIndex = record.indexOf('\n')
    const key = separatorIndex === -1 ? record : record.slice(0, separatorIndex)
    const value = separatorIndex === -1 ? '' : record.slice(separatorIndex + 1)
    const values = snapshot.get(key) ?? []
    values.push(value)
    snapshot.set(key, values)
  }
  return snapshot
}

export function createGitConfigSnapshotRunner(
  runGit: GitCommandRunner,
  options: { propagateReadErrors?: boolean; includeAllValues?: boolean } = {}
): GitCommandRunner {
  let snapshotPromise: Promise<GitConfigSnapshot | null> | null = null
  let snapshot: GitConfigSnapshot | null = null
  let interceptionDisabled = false

  const readSnapshot = (): Promise<GitConfigSnapshot | null> => {
    if (snapshot) {
      return Promise.resolve(snapshot)
    }
    if (!snapshotPromise) {
      // Publish the shared promise before any await so parallel resolvers coalesce.
      try {
        snapshotPromise = runGit(['config', '--list', '-z'])
          .then(({ stdout }) => {
            snapshot = parseGitConfigListSnapshot(stdout)
            return snapshot
          })
          .catch((error) => {
            if (options.propagateReadErrors) {
              throw error
            }
            // Fall back to real Git this round if snapshot loading fails.
            interceptionDisabled = true
            snapshotPromise = null
            return null
          })
      } catch (error) {
        if (options.propagateReadErrors) {
          snapshotPromise = Promise.reject(error)
          return snapshotPromise
        }
        interceptionDisabled = true
        snapshotPromise = null
        return Promise.resolve(null)
      }
    }
    return snapshotPromise
  }

  return async (args) => {
    if (interceptionDisabled || !isConfigGetCommand(args, options.includeAllValues)) {
      return runGit(args)
    }

    const configSnapshot = await readSnapshot()
    if (!configSnapshot) {
      return runGit(args)
    }

    const key = args.at(-1) ?? ''
    const values = configSnapshot.get(canonicalizeGitConfigLookupKey(key))
    if (!values?.length) {
      // Missing keys must reject like real config --get; callers branch on rejection.
      throw new GitConfigSnapshotKeyNotFoundError(key)
    }

    if (args[1] === '--null') {
      return { stdout: values.map((value) => `${value}\0`).join('') }
    }

    // Multivar reads use the last occurrence, matching config --get.
    return { stdout: args[1] === '--get-all' ? values.join('\n') : (values.at(-1) ?? '') }
  }
}
import { iterateNulDelimitedFields } from './nul-delimited-fields'
