import type { ExactEchoSample } from './echo-observation'

export const TYPING_LATENCY_SAMPLE_LIMIT = 2000

export type ExactLatencySampleWindow = {
  inputToDispatchMs: number[]
  dispatchToParseMs: number[]
  parseToPaintMs: number[]
  inputToPaintMs: number[]
  eventToHandlerMs: number[]
  eventToPaintMs: number[]
  dispatchToArrivalMs: number[]
  arrivalToWriteMs: number[]
  writeToParseMs: number[]
  outputBytes: number[]
  outputWrites: number[]
}

export function createExactLatencySampleWindow(): ExactLatencySampleWindow {
  return {
    inputToDispatchMs: [],
    dispatchToParseMs: [],
    parseToPaintMs: [],
    inputToPaintMs: [],
    eventToHandlerMs: [],
    eventToPaintMs: [],
    dispatchToArrivalMs: [],
    arrivalToWriteMs: [],
    writeToParseMs: [],
    outputBytes: [],
    outputWrites: []
  }
}

export function appendTypingLatencySample(values: number[], value: number): void {
  values.push(value)
  if (values.length > TYPING_LATENCY_SAMPLE_LIMIT) {
    values.shift()
  }
}

function appendOptionalSample(values: number[], value: number | null): void {
  if (value !== null) {
    appendTypingLatencySample(values, value)
  }
}

export function appendExactLatencySample(
  samples: ExactLatencySampleWindow,
  sample: ExactEchoSample
): void {
  appendTypingLatencySample(samples.inputToDispatchMs, sample.inputToDispatchMs)
  appendTypingLatencySample(samples.dispatchToParseMs, sample.dispatchToParseMs)
  appendTypingLatencySample(samples.parseToPaintMs, sample.parseToPaintMs)
  appendTypingLatencySample(samples.inputToPaintMs, sample.inputToPaintMs)
  appendOptionalSample(samples.eventToHandlerMs, sample.eventToHandlerMs)
  appendOptionalSample(samples.eventToPaintMs, sample.eventToPaintMs)
  appendOptionalSample(samples.dispatchToArrivalMs, sample.dispatchToArrivalMs)
  appendOptionalSample(samples.arrivalToWriteMs, sample.arrivalToWriteMs)
  appendOptionalSample(samples.writeToParseMs, sample.writeToParseMs)
  appendTypingLatencySample(samples.outputBytes, sample.outputBytes)
  appendTypingLatencySample(samples.outputWrites, sample.outputWrites)
}
