import type { PtyCreationDisposition } from '../../shared/claimed-agent-pty-owner'

export type PendingTerminalCreation = {
  completion: Promise<void>
  recover: () => Promise<void>
}

/** The complete ordinary call owns every lower attempt and acquired dependency. */
export class TerminalCreationWork {
  private readonly result = Promise.withResolvers<PtyCreationDisposition>()
  readonly completion = this.result.promise
  private readonly dependencies: Promise<PtyCreationDisposition>[] = []
  private readonly owners: {
    completion: Promise<void>
    exitCode: () => number | null
    recover?: () => Promise<void>
  }[] = []
  private uncertain = false

  join(disposition: Promise<PtyCreationDisposition>): void {
    this.dependencies.push(disposition)
  }

  dispatched(): void {
    this.uncertain = true
  }

  owner(
    completion: Promise<void>,
    exitCode: () => number | null,
    recover?: () => Promise<void>
  ): void {
    this.owners.push({ completion, exitCode, recover })
  }

  async finish(reconcile?: (release: () => Promise<void>) => Promise<void>): Promise<void> {
    const joined = await Promise.all(this.dependencies)
    const physical = [
      ...this.owners,
      ...joined.flatMap((entry) => (entry.kind === 'physical' ? [entry] : []))
    ]
    const release = async () => {
      await Promise.all(
        [...this.owners, ...joined.filter((entry) => entry.kind !== 'no-fork')].map((entry) =>
          entry.recover?.()
        )
      )
    }
    let recovery: Promise<void> | undefined
    const recover = () => {
      recovery ??= (reconcile ? reconcile(release) : release()).finally(() => {
        recovery = undefined
      })
      return recovery
    }
    if (this.uncertain || joined.some((entry) => entry.kind === 'unknown')) {
      this.result.resolve({ kind: 'unknown', recover })
    } else if (joined.some((entry) => entry.kind === 'failed')) {
      this.result.resolve({
        kind: 'failed',
        completion: Promise.all([
          ...physical.map((entry) => entry.completion),
          ...joined.flatMap((entry) => (entry.kind === 'failed' ? [entry.completion] : []))
        ]).then(() => {}),
        recover
      })
    } else if (physical.length) {
      this.result.resolve({
        kind: 'physical',
        completion: Promise.all(physical.map((entry) => entry.completion)).then(() => {}),
        exitCode: () => physical.at(-1)?.exitCode() ?? null,
        recover
      })
    } else {
      this.result.resolve({ kind: 'no-fork' })
    }
  }
}
