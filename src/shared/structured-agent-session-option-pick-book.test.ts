import { describe, expect, it } from 'vitest'
import {
  beginStructuredOptionPick,
  createStructuredOptionPickBook,
  observeStructuredPermissionReport,
  resetStructuredOptionPickBook,
  settleStructuredOptionPick,
  structuredOptionPickCommit
} from './structured-agent-session-option-pick-book'

describe('structured option pick commits', () => {
  it('commits only its own option when another option was picked since', () => {
    const book = createStructuredOptionPickBook()
    const model = beginStructuredOptionPick(book, 'model', 'opus', false)
    beginStructuredOptionPick(book, 'effort', 'low', false)
    expect(structuredOptionPickCommit(book, model, { model: 'opus', effort: 'high' })).toEqual({
      model: 'opus'
    })
  })

  it('commits nothing once the same option was picked again', () => {
    const book = createStructuredOptionPickBook()
    const first = beginStructuredOptionPick(book, 'model', 'opus', false)
    beginStructuredOptionPick(book, 'model', 'sonnet', false)
    expect(structuredOptionPickCommit(book, first, undefined)).toBeNull()
    settleStructuredOptionPick(book, first)
    expect(book.pending).toEqual({ model: 'sonnet' })
  })
})

describe('a permission pick over the agent report', () => {
  it('stands over the report it was made over until a different report arrives', () => {
    const book = createStructuredOptionPickBook()
    observeStructuredPermissionReport(book, '1:ask')
    beginStructuredOptionPick(book, 'model', 'opus', false)
    expect(book.permissionPickedOver).toBeNull()
    beginStructuredOptionPick(book, 'permissionMode', 'full-access', true)
    expect(book.permissionPickedOver).toBe('1:ask')
    observeStructuredPermissionReport(book, '1:ask')
    expect(book.permissionPickedOver).toBe('1:ask')
    observeStructuredPermissionReport(book, null)
    observeStructuredPermissionReport(book, '1:ask')
    expect(book.permissionPickedOver).toBeNull()
  })

  it('drops a refused pick, but not one a newer pick replaced, and on a new fence', () => {
    const book = createStructuredOptionPickBook()
    observeStructuredPermissionReport(book, '1:ask')
    const first = beginStructuredOptionPick(book, 'permissionMode', 'full-access', true)
    beginStructuredOptionPick(book, 'permissionMode', 'accept-edits', true)
    settleStructuredOptionPick(book, first, false)
    expect(book.permissionPickedOver).toBe('1:ask')
    const latest = beginStructuredOptionPick(book, 'permissionMode', 'auto', true)
    settleStructuredOptionPick(book, latest, false)
    expect(book.permissionPickedOver).toBeNull()
    beginStructuredOptionPick(book, 'permissionMode', 'auto', true)
    resetStructuredOptionPickBook(book)
    expect(book.permissionPickedOver).toBeNull()
  })
})
