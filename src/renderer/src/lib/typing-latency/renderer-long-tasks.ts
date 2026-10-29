/** Attribute slow echoes to renderer stalls by overlap; inclusive per sample, so overlap totals are never additive across samples. */
import { summarizeLatencySamples, type LatencyPercentiles } from './diagnostic-summary'
import type { ExactEchoSample } from './echo-observation'

const LONG_TASK_LIMIT = 500
const SLOWEST_SAMPLE_LIMIT = 10
const SCRIPTS_PER_TASK = 3

export type RendererLongTaskSource = 'long-animation-frame' | 'longtask' | 'unavailable'

export type RendererLongTaskScript = {
  durationMs: number
  invoker: string
  sourceFunctionName: string
  sourceURL: string
}

export type RendererLongTask = {
  startTime: number
  durationMs: number
  blockingDurationMs: number | null
  scripts: RendererLongTaskScript[]
}

export type RendererLongTaskLog = {
  source: RendererLongTaskSource
  tasks: RendererLongTask[]
  dispose: () => void
}

type LoafScriptLike = {
  duration?: number
  invoker?: string
  sourceFunctionName?: string
  sourceURL?: string
}

type LongTaskEntryLike = PerformanceEntry & {
  blockingDuration?: number
  scripts?: readonly LoafScriptLike[]
}

function supportedEntryType(): RendererLongTaskSource {
  const supported =
    typeof PerformanceObserver === 'undefined'
      ? []
      : (PerformanceObserver.supportedEntryTypes ?? [])
  if (supported.includes('long-animation-frame')) {
    return 'long-animation-frame'
  }
  return supported.includes('longtask') ? 'longtask' : 'unavailable'
}

function readScripts(entry: LongTaskEntryLike): RendererLongTaskScript[] {
  return [...(entry.scripts ?? [])]
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, SCRIPTS_PER_TASK)
    .map((script) => ({
      durationMs: Math.round(script.duration ?? 0),
      invoker: script.invoker ?? '',
      sourceFunctionName: script.sourceFunctionName ?? '',
      // Why: bundle file names identify the module; full URLs can carry local paths.
      sourceURL: (script.sourceURL ?? '').split(/[\\/]/).at(-1) ?? ''
    }))
}

export function observeRendererLongTasks(): RendererLongTaskLog {
  const source = supportedEntryType()
  const tasks: RendererLongTask[] = []
  if (source === 'unavailable') {
    return { source, tasks, dispose: () => undefined }
  }
  const record = (entries: readonly LongTaskEntryLike[]): void => {
    for (const entry of entries) {
      tasks.push({
        startTime: entry.startTime,
        durationMs: entry.duration,
        blockingDurationMs:
          typeof entry.blockingDuration === 'number' ? entry.blockingDuration : null,
        scripts: readScripts(entry)
      })
      if (tasks.length > LONG_TASK_LIMIT) {
        tasks.shift()
      }
    }
  }
  const observer = new PerformanceObserver((list) => record(list.getEntries()))
  observer.observe({ type: source, buffered: false })
  return {
    source,
    tasks,
    dispose: () => {
      // Why: entries queued before the observer callback ran would otherwise miss the final report.
      record(observer.takeRecords())
      observer.disconnect()
    }
  }
}

function overlapMs(task: RendererLongTask, start: number, end: number): number {
  return Math.max(
    0,
    Math.min(end, task.startTime + task.durationMs) - Math.max(start, task.startTime)
  )
}

type SlowEchoSample = {
  echoMs: number
  eventToHandlerMs: number | null
  inputToDispatchMs: number
  dispatchToArrivalMs: number | null
  arrivalToWriteMs: number | null
  writeToParseMs: number | null
  parseToPaintMs: number
  longTaskOverlapMs: number
  overlappingTasks: RendererLongTask[]
}

export type LongTaskOverlapReport = {
  source: RendererLongTaskSource
  observedTasks: number
  observedTaskMs: number
  exactSamples: number
  exactSamplesOverlapped: number
  /** Per-sample overlap of [event or handler, paint] with long tasks; samples can share a task. */
  overlapMs: LatencyPercentiles
  slowestExactSamples: SlowEchoSample[]
}

export function summarizeLongTaskOverlap(
  source: RendererLongTaskSource,
  tasks: readonly RendererLongTask[],
  samples: readonly ExactEchoSample[]
): LongTaskOverlapReport {
  const perSampleOverlap: number[] = []
  const decorated = samples.map((sample) => {
    const overlapping = tasks.filter(
      (task) => overlapMs(task, sample.startedAt, sample.paintedAt) > 0
    )
    const overlap = overlapping.reduce(
      (total, task) => total + overlapMs(task, sample.startedAt, sample.paintedAt),
      0
    )
    perSampleOverlap.push(overlap)
    return { sample, overlap, overlapping }
  })
  const slowest = decorated
    .sort(
      (a, b) =>
        (b.sample.eventToPaintMs ?? b.sample.inputToPaintMs) -
        (a.sample.eventToPaintMs ?? a.sample.inputToPaintMs)
    )
    .slice(0, SLOWEST_SAMPLE_LIMIT)
    .map(({ sample, overlap, overlapping }) => ({
      echoMs: Math.round(sample.eventToPaintMs ?? sample.inputToPaintMs),
      eventToHandlerMs: sample.eventToHandlerMs,
      inputToDispatchMs: sample.inputToDispatchMs,
      dispatchToArrivalMs: sample.dispatchToArrivalMs,
      arrivalToWriteMs: sample.arrivalToWriteMs,
      writeToParseMs: sample.writeToParseMs,
      parseToPaintMs: sample.parseToPaintMs,
      longTaskOverlapMs: Math.round(overlap),
      overlappingTasks: overlapping
    }))
  return {
    source,
    observedTasks: tasks.length,
    observedTaskMs: Math.round(tasks.reduce((total, task) => total + task.durationMs, 0)),
    exactSamples: samples.length,
    exactSamplesOverlapped: perSampleOverlap.filter((overlap) => overlap > 0).length,
    overlapMs: summarizeLatencySamples(perSampleOverlap),
    slowestExactSamples: slowest
  }
}
