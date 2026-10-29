// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import { getAutomationRunContent } from '../../../../shared/automation-run-content'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import type { AutomationRunViewState } from './automation-run-view-state'

// These fixtures exercise markdown without rendering diagrams.
const boundaryMocks = vi.hoisted(() => ({
  mermaid: vi.fn(() => {
    throw new Error('These fixtures must not render Mermaid diagrams')
  })
}))

vi.mock('@/components/sidebar/CommentMermaidBlock', () => ({ default: boundaryMocks.mermaid }))

const run: AutomationRun = {
  id: 'run-1',
  automationId: 'automation-1',
  title: 'Run 1',
  scheduledFor: 1,
  status: 'skipped_precheck',
  trigger: 'scheduled',
  workspaceId: 'wt-1',
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: 'Precheck exited with code 1.',
  startedAt: 1,
  dispatchedAt: null,
  createdAt: 1
}

function renderPage(viewState: AutomationRunViewState, selectedRun: AutomationRun = run): void {
  render(
    <AutomationRunDetailsPage
      automation={null}
      run={selectedRun}
      relativeNow={1}
      workspaceDisplay={null}
      viewState={viewState}
      canRerun={false}
      isRerunPending={false}
      onRerun={() => {}}
      onOpenWorkspace={() => {}}
      onBack={() => {}}
    />
  )
}

describe('AutomationRunDetailsPage', () => {
  afterEach(() => {
    cleanup()
    try {
      expect(boundaryMocks.mermaid).not.toHaveBeenCalled()
    } finally {
      boundaryMocks.mermaid.mockClear()
    }
  })

  it('enables the open action when the supplied view state allows it', () => {
    renderPage({
      availability: 'terminal',
      actionLabel: 'View run',
      statusLabel: 'Run is open',
      canOpen: true
    })
    expect(screen.getByRole('button', { name: 'View run' })).toBeEnabled()
  })

  it('hides the open action when the supplied view state disallows it', () => {
    renderPage({
      availability: 'metadata',
      actionLabel: 'View run',
      statusLabel: 'Workspace no longer available',
      canOpen: false
    })
    expect(screen.queryByRole('button', { name: 'View run' })).not.toBeInTheDocument()
    expect(screen.getByText('Precheck exited with code 1.')).toBeInTheDocument()
  })

  it('localizes empty desktop output while the shared mobile default remains available', async () => {
    const emptyRun: AutomationRun = { ...run, error: null }
    expect(getAutomationRunContent(emptyRun)).toBe('No output content available.')
    const originalLanguage = i18n.language
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    try {
      renderPage(
        {
          availability: 'metadata',
          actionLabel: 'View run',
          statusLabel: 'Run is complete',
          canOpen: false
        },
        emptyRun
      )
      expect(
        screen.getByText(es.auto.components.automations.runContent.noOutput)
      ).toBeInTheDocument()
    } finally {
      await i18n.changeLanguage(originalLanguage)
    }
  })
})
