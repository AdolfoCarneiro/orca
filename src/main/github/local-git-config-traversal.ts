const MAX_CONFIG_INCLUDE_DEPTH = 10
const MAX_CONFIG_NODE_READS = 4
const LITERAL_CONFIG_PATH_MODE = 1
const LEGACY_CONFIG_PATH_MODE = 2
const ALL_CONFIG_PATH_MODES = LITERAL_CONFIG_PATH_MODE | LEGACY_CONFIG_PATH_MODE

export type IncludedGitConfigPath = { current: string; legacy?: string }
export type LocalGitConfigNode = {
  signature: string
  includedPaths: IncludedGitConfigPath[]
  hasConditionalIncludes: boolean
}
type LocalGitConfigGraph = { signatures: string[]; hasConditionalIncludes: boolean }

type LocalGitConfigRead = {
  configPath: string
  depth: number
  modes: number
  visited: Map<string, number>
  reads: Map<string, Promise<LocalGitConfigNode>>
}

export function readLocalGitConfigSignatures(
  configPaths: string[],
  deadlineAt: number,
  readNode: (configPath: string, isActive: () => boolean) => Promise<LocalGitConfigNode>
): Promise<LocalGitConfigGraph | undefined> {
  const pending: LocalGitConfigRead[] = configPaths
    .map((configPath) => ({
      configPath,
      depth: 0,
      modes: ALL_CONFIG_PATH_MODES,
      visited: new Map(),
      reads: new Map()
    }))
    .toReversed()
  const signatures: string[] = []
  let hasConditionalIncludes = false
  let active = 0
  let declined = false
  const isActive = (): boolean => !declined && Date.now() < deadlineAt
  const decline = (): void => {
    declined = true
    pending.length = 0
  }
  return new Promise((settle) => {
    const drain = (): void => {
      if (!isActive()) {
        decline()
      }
      while (!declined && active < MAX_CONFIG_NODE_READS && pending.length > 0) {
        const next = pending.pop()
        if (!next) {
          break
        }
        if (next.depth > MAX_CONFIG_INCLUDE_DEPTH) {
          decline()
          break
        }
        const previousModes = next.visited.get(next.configPath) ?? 0
        const remainingModes = next.modes & ~previousModes
        if (!remainingModes) {
          continue
        }
        next.visited.set(next.configPath, previousModes | remainingModes)
        let read = next.reads.get(next.configPath)
        if (!read) {
          read = readNode(next.configPath, isActive)
          next.reads.set(next.configPath, read)
        }
        active += 1
        void read
          .then((node) => {
            if (!isActive()) {
              decline()
              return
            }
            hasConditionalIncludes ||= node.hasConditionalIncludes
            if (previousModes === 0) {
              signatures.push(node.signature)
            }
            for (let index = node.includedPaths.length - 1; index >= 0; index -= 1) {
              const path = node.includedPaths[index]
              const child = { ...next, depth: next.depth + 1 }
              if (path.legacy === undefined) {
                pending.push({ ...child, configPath: path.current, modes: remainingModes })
              } else {
                if (remainingModes & LEGACY_CONFIG_PATH_MODE) {
                  pending.push({
                    ...child,
                    configPath: path.legacy,
                    modes: LEGACY_CONFIG_PATH_MODE
                  })
                }
                if (remainingModes & LITERAL_CONFIG_PATH_MODE) {
                  pending.push({
                    ...child,
                    configPath: path.current,
                    modes: LITERAL_CONFIG_PATH_MODE
                  })
                }
              }
            }
          }, decline)
          .finally(() => {
            active -= 1
            drain()
          })
      }
      if (active === 0 && (declined || pending.length === 0)) {
        settle(declined ? undefined : { signatures, hasConditionalIncludes })
      }
    }
    drain()
  })
}
