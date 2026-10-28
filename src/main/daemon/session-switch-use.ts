import { randomUUID } from 'node:crypto'

export abstract class SessionSwitchUse {
  abstract get isTerminating(): boolean
  abstract beginTermination(): boolean
  private useRevision = 0

  protected switchClosing = false

  private switchWitness?: { token: string; revision: number; anchor: number }

  get isSwitchClosing(): boolean {
    return this.switchClosing
  }

  noteUse(): void {
    this.useRevision++
  }

  captureSwitchWitness(): string {
    const token = randomUUID()
    this.switchWitness = { token, revision: this.useRevision, anchor: performance.now() }
    return token
  }

  switchCloseCondition(condition: {
    token: string
    remainingMs: number
    ownedSpawn?: true
  }): () => boolean {
    const witness = this.switchWitness
    const deadline = (witness?.anchor ?? -Infinity) + Math.max(0, condition.remainingMs)
    return () =>
      Boolean(
        condition.ownedSpawn &&
        witness &&
        this.switchWitness === witness &&
        witness.token === condition.token &&
        witness.revision === this.useRevision &&
        performance.now() < deadline &&
        !this.isTerminating
      )
  }

  commitSwitchClose(check: () => boolean): boolean {
    if (!check() || !this.beginTermination()) {
      return false
    }
    this.switchClosing = true
    return true
  }
}
