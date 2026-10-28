import { MailPending, type Interest, type SourceIdentity } from './structured-mail-source-discovery'

/** Source ownership outlives target leaves and every awaited ordinary acceptance. */
export class MailSourceWork {
  private readonly mailboxes = new Map<string, MailPending>()
  private readonly scopes = new Map<string, Set<string>>()
  private readonly attempts = new Map<string, object>()
  pending(mailbox: string): MailPending {
    let pending = this.mailboxes.get(mailbox)
    if (!pending) {
      pending = new MailPending((id, present) => {
        const scopes = this.scopes.get(id) ?? new Set<string>()
        if (present) {
          scopes.add(mailbox)
        } else {
          scopes.delete(mailbox)
        }
        if (scopes.size) {
          this.scopes.set(id, scopes)
        } else {
          this.scopes.delete(id)
        }
      })
      this.mailboxes.set(mailbox, pending)
    }
    return pending
  }
  clear(): void {
    this.mailboxes.clear()
    this.scopes.clear()
    this.attempts.clear()
  }
  forget(id: string): void {
    for (const mailbox of this.scopes.get(id) ?? []) {
      this.mailboxes.get(mailbox)?.delete(id)
    }
  }
  async run(input: {
    mailbox: string
    interest: Interest
    source: SourceIdentity
    current: () => boolean
    offer: (
      current: () => boolean,
      capture: () => void,
      retire: (id: string) => void
    ) => Promise<void>
    retire: (id: string) => void
    wake: (mailbox: string) => void
  }): Promise<void> {
    const { source, interest, current } = input
    if (this.attempts.has(source.id)) {
      return
    }
    const token = {}
    this.attempts.set(source.id, token)
    let revision = interest.dirty.get(source.id)
    const owned = () =>
      current() &&
      this.attempts.get(source.id) === token &&
      interest.dirty.get(source.id) === revision
    try {
      await input.offer(
        owned,
        () => {
          interest.db.mailSourceMutations.flushCommitted()
          revision = interest.dirty.get(source.id)
        },
        (id) => {
          if (owned()) {
            input.retire(id)
          }
        }
      )
      if (owned()) {
        interest.dirty.delete(source.id)
      }
    } finally {
      if (this.attempts.get(source.id) === token) {
        this.attempts.delete(source.id)
        for (const mailbox of this.scopes.get(source.id) ?? []) {
          queueMicrotask(() => input.wake(mailbox))
        }
      }
    }
  }
}
