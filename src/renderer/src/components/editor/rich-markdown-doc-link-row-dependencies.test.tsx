// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMarkdownDocCompletionDocuments } from './markdown-doc-completions'
import {
  createCountedDocuments,
  createMenuOwner,
  disposeMenuOwner,
  menuController,
  menuEditor,
  renderMenuOwner,
  selectTrigger,
  type CountedDocuments,
  type MenuOwner
} from './rich-markdown-doc-link-row-dependencies.test-fixture'

describe('production menu row dependencies', () => {
  const owners: MenuOwner[] = []

  afterEach(async () => {
    for (const owner of owners.splice(0)) {
      await disposeMenuOwner(owner)
    }
    vi.restoreAllMocks()
  })

  async function open(documents: CountedDocuments, query = 'doc'): Promise<MenuOwner> {
    const owner = await createMenuOwner(documents.documents, query)
    owners.push(owner)
    return owner
  }

  function expectRows(owner: MenuOwner, documents: CountedDocuments, query: string): void {
    const matches = getMarkdownDocCompletionDocuments(documents.plain, query)
    const controller = menuController(owner)
    expect(controller.docLinkRows).toEqual(
      matches.slice(0, 20).map((document) => ({ kind: 'document', document }))
    )
    expect(controller.docLinkTotalMatches).toBe(matches.length)
    expect(controller.filteredDocLinkRowsRef.current).toBe(controller.docLinkRows)
  }

  it.each([
    { documents: 100, queryUnits: 3, ownerCount: 1 },
    { documents: 1_000, queryUnits: 3, ownerCount: 1 },
    { documents: 1_000, queryUnits: 128, ownerCount: 1 },
    { documents: 1_000, queryUnits: 1_280, ownerCount: 1 },
    { documents: 1_000, queryUnits: 3, ownerCount: 8 }
  ])(
    'skips rescans for $documents documents, $queryUnits query units, $ownerCount owners',
    async ({ documents, queryUnits, ownerCount }) => {
      const query = `doc${' '.repeat(queryUnits - 3)}`
      const population: { owner: MenuOwner; counted: CountedDocuments; syncCalls: number }[] = []
      for (let index = 0; index < ownerCount; index++) {
        const counted = createCountedDocuments(documents, index)
        const owner = await open(counted, query)
        expect(counted.documents).toHaveLength(documents)
        expect(counted.reads).toBe(documents)
        counted.reads = 0
        population.push({ owner, counted, syncCalls: owner.syncCalls })
      }
      const active = population[0]
      if (!active) {
        throw new Error('Missing active document menu')
      }
      const editor = menuEditor(active.owner)
      const initialDocument = editor.state.doc
      const initialMenu = menuController(active.owner).docLinkMenu
      const initialRows = menuController(active.owner).docLinkRows
      const caret = editor.state.selection.from
      await act(async () => menuController(active.owner).setSelectedDocLinkIndex(7))

      for (let update = 0; update < 3; update++) {
        await act(async () => {
          editor.view.dispatch(editor.state.tr.delete(caret, caret + 1))
        })
        const controller = menuController(active.owner)
        expect(editor.state.selection.from).toBe(caret)
        expect(controller.docLinkMenu).toEqual(initialMenu)
        expect(controller.docLinkMenu).not.toBe(initialMenu)
        expect(controller.selectedDocLinkIndex).toBe(7)
        expectRows(active.owner, active.counted, query)
      }
      expect(editor.state.doc).not.toBe(initialDocument)
      expect(editor.state.doc.firstChild?.textContent).toBe(`[[${query}ffix`)
      expect(active.owner.syncCalls - active.syncCalls).toBe(3)
      for (const idle of population.slice(1)) {
        expect(idle.owner.syncCalls).toBe(idle.syncCalls)
        expect(idle.counted.reads).toBe(0)
      }
      expect(active.counted.reads).toBe(0)
      expect(menuController(active.owner).docLinkRows).toBe(initialRows)
    }
  )

  it('keeps geometry and range fresh for equal-query selection changes', async () => {
    const counted = createCountedDocuments(1_000)
    const owner = await open(counted)
    const initialRows = menuController(owner).docLinkRows
    const initialMenu = menuController(owner).docLinkMenu
    await act(async () => menuController(owner).setSelectedDocLinkIndex(5))
    counted.reads = 0
    const calls = owner.syncCalls
    await selectTrigger(owner, 1)
    const controller = menuController(owner)
    const position = menuEditor(owner).state.selection.from
    expect(controller.docLinkMenu).toEqual({
      query: 'doc',
      from: position - 5,
      to: position,
      left: position * 3 - 5,
      top: position * 2 + 21
    })
    expect(controller.docLinkMenu?.from).not.toBe(initialMenu?.from)
    expect(controller.selectedDocLinkIndex).toBe(5)
    expect(owner.syncCalls - calls).toBe(1)
    expectRows(owner, counted, 'doc')
    expect(counted.reads).toBe(0)
    expect(controller.docLinkRows).toBe(initialRows)
  })

  it('rebuilds rows when a real selection change changes the query', async () => {
    const counted = createCountedDocuments(100)
    const owner = await open(counted)
    await act(async () => menuController(owner).setSelectedDocLinkIndex(7))
    counted.reads = 0
    const editor = menuEditor(owner)
    await act(async () => {
      editor.commands.setTextSelection(editor.state.selection.from - 1)
    })
    expect(menuController(owner).docLinkMenu?.query).toBe('do')
    expect(menuController(owner).selectedDocLinkIndex).toBe(0)
    expectRows(owner, counted, 'do')
    expect(counted.reads).toBe(100)
  })

  it('refreshes a replacement document list and clamps the selected row', async () => {
    const old = createCountedDocuments(100)
    const owner = await open(old)
    await act(async () => menuController(owner).setSelectedDocLinkIndex(7))
    old.reads = 0
    const replacement = createCountedDocuments(4, 9)
    owner.documents = replacement.documents
    await renderMenuOwner(owner)
    expectRows(owner, replacement, 'doc')
    expect(menuController(owner).selectedDocLinkIndex).toBe(1)
    expect(old.reads).toBe(0)
    expect(replacement.reads).toBe(4)
  })

  it('clears rows without a list and rebuilds when the list returns', async () => {
    const counted = createCountedDocuments(100)
    const owner = await open(counted)
    counted.reads = 0
    owner.documents = undefined
    await renderMenuOwner(owner)
    expect(menuController(owner).docLinkMenu?.query).toBe('doc')
    expect(menuController(owner).docLinkRows).toEqual([])
    expect(menuController(owner).docLinkTotalMatches).toBe(0)
    expect(counted.reads).toBe(0)
    owner.documents = counted.documents
    await renderMenuOwner(owner)
    expectRows(owner, counted, 'doc')
    expect(counted.reads).toBe(100)
  })

  it('clears a dismissed menu and recomputes when the next content edit reopens it', async () => {
    const counted = createCountedDocuments(100)
    const owner = await open(counted)
    counted.reads = 0
    await act(async () => menuController(owner).setDocLinkMenu(null))
    expect(menuController(owner).docLinkRows).toEqual([])
    expect(menuController(owner).docLinkTotalMatches).toBe(0)
    expect(counted.reads).toBe(0)
    const editor = menuEditor(owner)
    await act(async () => {
      const position = editor.state.selection.from
      editor.view.dispatch(editor.state.tr.delete(position, position + 1))
    })
    expectRows(owner, counted, 'doc')
    expect(menuController(owner).docLinkMenu?.query).toBe('doc')
    expect(counted.reads).toBe(100)
  })

  it('keeps an open empty query distinct from a closed menu', async () => {
    const counted = createCountedDocuments(100)
    const owner = await open(counted, '')
    expectRows(owner, counted, '')
    expect(menuController(owner).docLinkTotalMatches).toBe(100)
    expect(counted.reads).toBe(100)
    counted.reads = 0
    await selectTrigger(owner, 1)
    expect(menuController(owner).docLinkMenu?.query).toBe('')
    expectRows(owner, counted, '')
    expect(counted.reads).toBe(0)
  })

  it('keeps oversized UTF-8 queries behind the existing document scan gate', async () => {
    const counted = createCountedDocuments(100)
    const query = 'é'.repeat(1_025)
    const owner = await open(counted, query)
    expect(menuController(owner).docLinkMenu?.query).toBe(query)
    expect(menuController(owner).docLinkRows).toEqual([])
    expect(menuController(owner).docLinkTotalMatches).toBe(0)
    expect(counted.reads).toBe(0)
    await selectTrigger(owner, 1)
    expect(menuController(owner).docLinkMenu?.query).toBe(query)
    expect(counted.reads).toBe(0)
  })

  it('does not rescan on row selection or an unchanged owner render', async () => {
    const counted = createCountedDocuments(100)
    const owner = await open(counted)
    const rows = menuController(owner).docLinkRows
    counted.reads = 0
    await act(async () => menuController(owner).setSelectedDocLinkIndex(4))
    await renderMenuOwner(owner)
    expect(menuController(owner).selectedDocLinkIndex).toBe(4)
    expectRows(owner, counted, 'doc')
    expect(counted.reads).toBe(0)
    expect(menuController(owner).docLinkRows).toBe(rows)
  })
})
