import React from 'react'
import { PowerOff } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

type WslDistroNotRunning = NonNullable<DetectedWorktreeListResult['wslDistroStopped']>

/** A stopped distro is a state, not a failure: neutral, with stored rows and a non-booting re-check. */
export function RepoWslDistroStoppedIndicator({
  repo,
  notRunning
}: {
  repo: Repo
  notRunning: WslDistroNotRunning
}): React.JSX.Element {
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const [pending, setPending] = React.useState(false)
  const title =
    notRunning.state === 'stopped'
      ? translate(
          'auto.components.sidebar.RepoScanUnavailableIndicator.wslStoppedTitle',
          'WSL distro {{value0}} is stopped',
          { value0: notRunning.distro }
        )
      : translate(
          'auto.components.sidebar.RepoScanUnavailableIndicator.wslUnverifiableTitle',
          "Couldn't confirm WSL distro {{value0}} is running",
          { value0: notRunning.distro }
        )
  const checkAgain = translate(
    'auto.components.sidebar.RepoScanUnavailableIndicator.wslCheckAgain',
    'Check again'
  )
  return (
    <TooltipProvider disableHoverableContent={false}>
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-repo-header-action=""
            className={cn(
              'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground',
              pending && 'opacity-60'
            )}
            aria-label={`${title}. ${checkAgain}`}
            aria-busy={pending}
            disabled={pending}
            onKeyDown={stopRepoHeaderKeyboardToggle}
            onPointerDown={handleRepoHeaderActionPointerDown}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setPending(true)
              void fetchWorktrees(repo.id, {
                executionHostId: getRepoExecutionHostId(repo)
              }).finally(() => setPending(false))
            }}
          >
            <PowerOff className="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
          <div className="space-y-1">
            <div className="font-medium">{title}</div>
            <div className="text-muted-foreground">
              {translate(
                'auto.components.sidebar.RepoScanUnavailableIndicator.wslRetained',
                'Showing the worktrees Orca already knew about. They refresh when Orca sees the distro running.'
              )}
            </div>
            {notRunning.state === 'stopped' ? (
              <div className="text-muted-foreground">
                {translate(
                  'auto.components.sidebar.RepoScanUnavailableIndicator.wslStartHint',
                  'Open a terminal in this project to start it.'
                )}
              </div>
            ) : null}
            <div className="text-muted-foreground">
              {translate(
                'auto.components.sidebar.RepoScanUnavailableIndicator.wslCheckAgainHint',
                'Click the icon to check again.'
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
