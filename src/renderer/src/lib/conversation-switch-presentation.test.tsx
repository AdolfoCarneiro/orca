import { useRef } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatNoticeRow } from '@/components/native-chat/NativeChatNoticeRow'
import {
  beginSwitchPresentation,
  reportSwitchPresentationFailure,
  SwitchPresentationContext,
  useSwitchPresentation,
  useSwitchPresentationRows
} from './conversation-switch-presentation'

// @vitest-environment happy-dom

const target = { kind: 'local' as const }
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
function List({ item }: { item?: string }) {
  const root = useRef<HTMLDivElement>(null)
  useSwitchPresentationRows(root)
  return (
    <div ref={root} data-testid="list">
      {item && (
        <div data-switch-item-id={item}>
          <NativeChatNoticeRow
            messageId={item}
            agentName="Codex"
            block={{ type: 'text', text: 'Codex could not start. Try again.' }}
          />
        </div>
      )}
    </div>
  )
}
function Visit({ item, visible = true }: { item?: string; visible?: boolean }) {
  const visit = useSwitchPresentation(target, 'conversation', visible)
  return (
    <SwitchPresentationContext.Provider value={visit}>
      <List item={item} />
    </SwitchPresentationContext.Provider>
  )
}
function bounds(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    width: 200,
    height: 30,
    top,
    bottom: top + 30,
    left: 0,
    right: 200,
    toJSON: () => ({})
  }
}
it.each(['before row', 'offscreen', 'absent root'] as const)(
  'selects one clicked-context report for the exact failure %s, without hiding future manual history',
  (timing) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return bounds(timing === 'offscreen' && this.dataset.switchItemId ? 5_000 : 0)
    })
    const visit = beginSwitchPresentation(target, 'conversation')
    const view =
      timing === 'absent root'
        ? undefined
        : render(<Visit item={timing === 'before row' ? undefined : 'failed-new'} />)
    act(() => {
      expect(reportSwitchPresentationFailure(visit, 'failed-new')).toBe(true)
    })
    expect(reportSwitchPresentationFailure(visit, 'failed-new')).toBe(false)
    view?.rerender(<Visit item="failed-new" />)
    if (view) {
      expect(screen.queryByText('Codex could not start. Try again.')).toBeNull()
    }
    view?.unmount()
    visit.release()
    render(<Visit item="failed-new" />)
    expect(screen.getByText('Codex could not start. Try again.')).toBeTruthy()
  }
)
it('uses the currently visible exact row, never an older equal failure', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => bounds(0))
  const visit = beginSwitchPresentation(target, 'conversation')
  const view = render(<Visit item="old-failure" />)
  view.rerender(<Visit item="selected-failure" />)
  act(() => {
    expect(reportSwitchPresentationFailure(visit, 'selected-failure')).toBe(false)
  })
  expect(screen.getByText('Codex could not start. Try again.')).toBeTruthy()
  expect(reportSwitchPresentationFailure(visit, 'selected-failure')).toBe(false)
})

it('does not toast again when the exact failure was shown before its result but has since left the viewport', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => bounds(0))
  const visit = beginSwitchPresentation(target, 'conversation')
  const view = render(<Visit item="selected-failure" />)
  expect(visit.presentedItems.has('selected-failure')).toBe(true)
  view.rerender(<Visit />)
  expect(reportSwitchPresentationFailure(visit, 'selected-failure')).toBe(false)
  view.unmount()
  visit.release()
})
it('inspects only mounted virtual rows once per current-visit render, without consulting history', () => {
  const geometry = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(() => bounds(0))
  const visit = beginSwitchPresentation(target, 'conversation')
  const view = render(<Visit item="mounted-only" />)
  geometry.mockClear()
  view.rerender(<Visit item="next-mounted" />)
  expect(visit.presentedItems.has('next-mounted')).toBe(true)
  expect(geometry.mock.calls.length).toBeLessThanOrEqual(4)
  view.unmount()
  visit.release()
})

it.each([100, 1000])(
  'bounds viewport work by %i mounted rows and tears it down at selected settlement',
  (count) => {
    const geometry = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => bounds(0))
    function Rows() {
      const root = useRef<HTMLDivElement>(null)
      useSwitchPresentationRows(root)
      return (
        <div ref={root} data-testid="viewport">
          {Array.from({ length: count }, (_, i) => (
            <div key={i} data-switch-item-id={`item-${i}`} />
          ))}
        </div>
      )
    }
    function ScaleVisit() {
      const visit = useSwitchPresentation(target, 'scale', true)
      return (
        <SwitchPresentationContext.Provider value={visit}>
          <Rows />
        </SwitchPresentationContext.Provider>
      )
    }
    const visit = beginSwitchPresentation(target, 'scale')
    const view = render(<ScaleVisit />)
    geometry.mockClear()
    act(() => screen.getByTestId('viewport').dispatchEvent(new Event('scroll')))
    expect(geometry.mock.calls.length).toBe(2 * count)
    expect(visit.presentedItems.size).toBe(count)
    act(() => {
      expect(reportSwitchPresentationFailure(visit, 'item-1')).toBe(false)
    })
    expect(visit.presentedItems.size).toBe(0)
    geometry.mockClear()
    act(() => screen.getByTestId('viewport').dispatchEvent(new Event('scroll')))
    view.rerender(<ScaleVisit />)
    expect(geometry).not.toHaveBeenCalled()
    view.unmount()
    visit.release()
  }
)

it.each([10, 100])(
  'isolates actual visit and notice subscriptions across %i mounted consumers',
  (count) => {
    let renders = 0
    const visits: ReturnType<typeof beginSwitchPresentation>[] = []
    function Reader({
      id,
      host = target
    }: {
      id: string
      host?: typeof target | { kind: 'environment'; environmentId: string }
    }) {
      renders++
      const visit = useSwitchPresentation(host, id, true)
      return (
        <SwitchPresentationContext.Provider value={visit}>
          <List item="failure" />
        </SwitchPresentationContext.Provider>
      )
    }
    render(
      <>
        {Array.from({ length: count }, (_, i) => (
          <Reader key={i} id={`unrelated-${i}`} />
        ))}
        <Reader id="addressed" />
        <Reader id="addressed" host={{ kind: 'environment', environmentId: 'other' }} />
      </>
    )
    renders = 0
    act(() => {
      visits.push(beginSwitchPresentation(target, 'foreign'))
    })
    expect(renders).toBe(0)
    act(() => {
      visits.push(beginSwitchPresentation(target, 'addressed'))
    })
    expect(renders).toBe(1)
    renders = 0
    act(() => {
      reportSwitchPresentationFailure(visits[1], 'failure')
    })
    expect(renders).toBe(0)
    cleanup()
    visits.forEach((visit) => visit.release())
  }
)
