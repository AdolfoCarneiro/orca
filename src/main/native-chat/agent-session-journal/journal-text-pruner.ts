import type { JournalStoreHost } from './journal-store-collaborators'
import type { JournalRow } from './journal-row-schema'
import { deleteJournalTextRange } from './journal-row-table'
import { JournalTextProofCache } from './journal-text-proof-cache'
import { JournalTextValidatorUnavailableError } from './journal-text-validation-client'

/** One bounded unit per queue turn; failure retains the pieces and stops this drain. */
export class JournalTextPruner {
  private scheduled: ReturnType<typeof setImmediate> | null = null
  private drain: 'open' | 'failed' | 'closed' = 'open'
  private readonly proofs: JournalTextProofCache
  private retry: ReturnType<typeof setTimeout> | null = null
  private retryDelay = 250

  constructor(private readonly host: JournalStoreHost) {
    this.proofs = new JournalTextProofCache(host.database())
  }

  committed(rows: readonly JournalRow[]): void {
    if (this.drain === 'closed') {
      return
    }
    if (rows.some((row) => row.kind === 'item' || row.kind === 'lifecycle-batch')) {
      this.drain = 'open'
      if (!this.retry && !this.proofs.pending && this.attempt()) {
        this.schedule()
      }
    } else {
      this.schedule()
    }
  }

  schedule(): void {
    if (
      this.drain !== 'open' ||
      this.scheduled ||
      this.retry ||
      this.proofs.pending ||
      this.host.readOnly() ||
      !this.host.state().textIndex.ready.size
    ) {
      return
    }
    const epoch = this.host.state().epoch
    this.scheduled = setImmediate(() => {
      this.scheduled = null
      if (this.drain !== 'open') {
        return
      }
      if (this.host.state().epoch !== epoch) {
        this.schedule()
        return
      }
      void this.host
        .serialize(() => this.attempt())
        .then(
          (ok) => {
            if (ok) {
              this.schedule()
            }
          },
          (error: unknown) => this.failed(error)
        )
    })
    const timer: unknown = this.scheduled
    if (
      typeof timer === 'object' &&
      timer !== null &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref()
    }
  }

  close(): void {
    this.drain = 'closed'
    if (this.scheduled) {
      clearImmediate(this.scheduled)
    }
    this.scheduled = null
    if (this.retry) {
      clearTimeout(this.retry)
    }
    this.retry = null
    this.proofs.close()
  }

  private attempt(): boolean {
    if (this.drain !== 'open' || this.host.readOnly() || this.proofs.pending) {
      return false
    }
    try {
      this.pruneOne()
      return true
    } catch (error) {
      if (this.scheduled) {
        clearImmediate(this.scheduled)
      }
      this.scheduled = null
      this.failed(error)
      return false
    } finally {
      const pending = this.proofs.pending
      if (pending) {
        void pending.then(
          () => {
            this.retryDelay = 250
            this.schedule()
          },
          (error: unknown) => this.failed(error)
        )
      }
    }
  }

  private failed(error: unknown): void {
    if (this.drain === 'closed') {
      return
    }
    if (error instanceof JournalTextValidatorUnavailableError) {
      this.retry = setTimeout(() => {
        this.retry = null
        this.schedule()
      }, this.retryDelay)
      this.retry.unref?.()
      this.retryDelay = Math.min(30_000, this.retryDelay * 2)
    } else {
      this.drain = 'failed'
    }
    console.warn('[journal-text-prune] keeping saved text pieces:', {
      sessionId: this.host.identity.sessionId,
      error
    })
  }

  private pruneOne(): void {
    const state = this.host.state()
    const key = state.textIndex.ready.values().next().value
    if (key === undefined) {
      return
    }
    const piece = state.textIndex.pieces.get(key)
    if (!piece) {
      return
    }
    let commit: (() => void) | undefined
    this.host.database().transaction((db) => {
      this.proofs.begin(db)
      const query = { sessionId: this.host.identity.sessionId, epoch: state.epoch }
      const item = { ...query, itemId: piece.itemId, field: piece.field }
      const boundaryQuery = { ...query, seq: state.textIndex.sparseAfter ?? 0 }
      const markerQuery = { ...item, seq: piece.marker?.seq ?? 0, revision: piece.marker?.revision }
      const witnessQuery = {
        ...item,
        seq: piece.witness?.seq ?? 0,
        revision: piece.revision,
        settlementId: piece.witness?.settlementId
      }
      const boundary = this.proofs.read(db, boundaryQuery)
      if (!boundary) {
        return
      }
      const marker = this.proofs.read(db, markerQuery)
      if (!marker) {
        return
      }
      const witness = this.proofs.read(db, witnessQuery)
      if (!witness) {
        return
      }
      if (
        !boundary.boundary ||
        marker.kind !== 'item' ||
        marker.v < 5 ||
        marker.itemRevision === null ||
        witness.itemRevision === null ||
        marker.itemRevision !== piece.marker?.revision ||
        marker.itemRevision >= witness.itemRevision ||
        (piece.marker?.seq ?? 0) >= (piece.witness?.seq ?? 0) ||
        !witness.settlementMatches ||
        !marker.hasField ||
        !witness.hasField ||
        state.replayTextDebt?.size
      ) {
        throw new Error('journal_text_prune_witness_invalid')
      }
      const selection = state.textIndex.select(key, piece, 253, (seq) => {
        const target = this.proofs.read(db, { ...item, seq })
        if (!target) {
          return false
        }
        if (
          target.kind !== 'text-delta' ||
          !target.deltaMatches ||
          target.deltaRevision === null ||
          target.deltaRevision >= (witness.itemRevision ?? 0) ||
          seq <= (piece.marker?.seq ?? 0) ||
          seq >= (piece.witness?.seq ?? 0) ||
          seq >= state.lastSequence ||
          state.textIndex.isProtected(seq)
        ) {
          throw new Error('journal_text_prune_target_invalid')
        }
        return true
      })
      for (const [first, last] of selection.ranges) {
        deleteJournalTextRange(db, this.host.identity.sessionId, state.epoch, first, last)
      }
      this.proofs.assertCurrent(db, [boundaryQuery, markerQuery, witnessQuery])
      commit = () => {
        selection.commit()
        this.proofs.retired(selection.sequences)
      }
    })
    commit?.()
  }
}
