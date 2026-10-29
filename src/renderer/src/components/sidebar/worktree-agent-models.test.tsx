import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { CompactAgentRow } from './worktree-card-compact-agent-row'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))
vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

const NOW = 2000
const LEAF = '11111111-1111-4111-8111-111111111111'
function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'folder-1',
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}
function entry(id: string): AgentStatusEntry {
  return {
    paneKey: `${id}:${LEAF}`,
    state: 'working',
    agentType: 'claude',
    prompt: 'Review',
    updatedAt: NOW,
    stateStartedAt: 1000,
    stateHistory: [],
    model: '  reported-model  '
  }
}

function sourceRows() {
  const parent = entry('hook')
  parent.subagents = [
    {
      id: 'child',
      state: 'working',
      startedAt: 1500,
      model: 'child-model',
      description: 'Child review'
    }
  ]
  return buildWorktreeAgentRows({
    tabs: [tab('hook'), tab('title')],
    entries: [parent, { ...entry('orphan'), worktreeId: 'folder-1', tabId: 'orphan' }],
    retained: [
      {
        entry: entry('retained'),
        tab: tab('retained'),
        worktreeId: 'folder-1',
        agentType: 'claude',
        startedAt: 1000
      }
    ],
    ptyIdsByTabId: { hook: ['hook-pty'], title: ['title-pty'] },
    runtimePaneTitlesByTabId: { title: { 1: '✳ Claude Code' } },
    terminalLayoutsByTabId: {
      title: { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    },
    now: NOW
  })
}

describe('agent model visibility across row sources', () => {
  it.each(['compact', 'full'] as const)(
    'shows only reported models and hides them for every %s row source',
    (layout) => {
      const rows = sourceRows()
      expect(rows).toHaveLength(5)
      expect(rows.find((row) => row.tab.id === 'title')?.entry.model).toBeUndefined()
      expect(
        rows
          .filter((row) => row.entry.model)
          .map((row) => row.rowSource)
          .sort()
      ).toEqual(['live', 'live', 'retained', 'subagent'])
      for (const agent of rows) {
        const render = (showModel?: boolean) =>
          renderToStaticMarkup(
            <TooltipProvider>
              {layout === 'compact' ? (
                <CompactAgentRow
                  agent={agent}
                  now={NOW}
                  onActivate={() => {}}
                  showModel={showModel}
                />
              ) : (
                <DashboardAgentRow
                  agent={agent}
                  now={NOW}
                  onActivate={() => {}}
                  onDismiss={() => {}}
                  showModel={showModel}
                />
              )}
            </TooltipProvider>
          )
        const model = agent.entry.model?.trim()
        if (model) {
          expect(render()).toContain(`title="${model}"`)
          expect(render(false)).not.toContain(`title="${model}"`)
          expect(render(true)).toContain(`title="${model}"`)
        } else {
          expect(render()).not.toContain('font-mono')
        }
      }
    }
  )
})
