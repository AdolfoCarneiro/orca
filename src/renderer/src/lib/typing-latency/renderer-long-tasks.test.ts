import { describe, expect, it } from 'vitest'
import type { ExactEchoSample } from './echo-observation'
import { summarizeLongTaskOverlap, type RendererLongTask } from './renderer-long-tasks'

function sample(startedAt: number, paintedAt: number): ExactEchoSample {
  return {
    attribution: 'single-input',
    source: 'direct',
    text: 'a',
    inputToDispatchMs: 0,
    dispatchToParseMs: 0,
    parseToPaintMs: 0,
    inputToPaintMs: paintedAt - startedAt,
    eventToHandlerMs: 0,
    eventToPaintMs: paintedAt - startedAt,
    dispatchToArrivalMs: null,
    arrivalToWriteMs: null,
    writeToParseMs: null,
    startedAt,
    paintedAt,
    outputBytes: 1,
    outputWrites: 1
  }
}

function task(startTime: number, durationMs: number): RendererLongTask {
  return { startTime, durationMs, blockingDurationMs: null, scripts: [] }
}

describe('summarizeLongTaskOverlap', () => {
  it('clips overlap to each echo interval and lets samples share one stall', () => {
    const report = summarizeLongTaskOverlap(
      'long-animation-frame',
      [task(100, 120), task(400, 60)],
      [sample(90, 150), sample(140, 260), sample(300, 320)]
    )

    expect(report).toMatchObject({
      observedTasks: 2,
      observedTaskMs: 180,
      exactSamples: 3,
      exactSamplesOverlapped: 2
    })
    expect(
      report.slowestExactSamples.map((entry) => [entry.echoMs, entry.longTaskOverlapMs])
    ).toEqual([
      [120, 80],
      [60, 50],
      [20, 0]
    ])
  })
})
