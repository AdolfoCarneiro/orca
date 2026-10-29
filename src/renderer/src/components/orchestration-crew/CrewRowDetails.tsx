import { Badge } from '@/components/ui/badge'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration-crew'

export function CrewRowTime({ at }: { at?: string }) {
  if (!at) {
    return null
  }
  const date = new Date(at.includes('T') ? at : `${at.replace(' ', 'T')}Z`)
  return Number.isFinite(date.getTime()) ? (
    <time dateTime={date.toISOString()} className="shrink-0 text-2xs text-muted-foreground">
      {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </time>
  ) : null
}

export function CrewRowDetails({ row }: { row: OrchestrationCrewRow }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 px-3 pb-3 text-xs">
      <dt className="text-muted-foreground">Task</dt>
      <dd>
        {row.task ? (
          <>
            <Badge variant="outline" className="mr-1">
              {row.task.state}
            </Badge>
            {row.task.title}
          </>
        ) : (
          'No shared task'
        )}
      </dd>
      {row.progress ? (
        <>
          <dt className="text-muted-foreground">Progress</dt>
          <dd>{row.progress}</dd>
        </>
      ) : null}
      {row.pendingQuestion ? (
        <>
          <dt className="text-status-warning">Asks you</dt>
          <dd className="whitespace-pre-wrap break-words">{row.pendingQuestion.preview}</dd>
        </>
      ) : row.latest ? (
        <>
          <dt className="text-muted-foreground">Latest</dt>
          <dd className="min-w-0">
            <span className="text-2xs text-muted-foreground">
              {row.latest.direction === 'to' ? 'To' : 'From'} {row.label} ·{' '}
              <CrewRowTime at={row.latest.at} />
            </span>
            <blockquote className="mt-1 whitespace-pre-wrap break-words border-l border-border pl-2">
              {row.latest.preview}
            </blockquote>
          </dd>
        </>
      ) : null}
    </dl>
  )
}
