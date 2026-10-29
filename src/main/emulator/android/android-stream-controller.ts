import type { EmulatorSessionInfo } from '../emulator-types'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import type { AndroidCommandRunner } from './android-command-runner'
import {
  androidStreamSessionInfo,
  type AndroidStreamHandle,
  type StartAndroidStream
} from './android-stream-session-starter'
import { scrcpyVideoRegistry } from '../scrcpy-video-registry'
import { EmulatorError } from '../emulator-errors'

export type AndroidStreamControllerDeps = {
  runner: AndroidCommandRunner
  sdk: () => AndroidSdkPaths
  ensureJar: () => Promise<string>
  startStreamSession: StartAndroidStream
  maxSize: number
}

// Deduplicate starts so racing attaches cannot launch competing scrcpy servers.
export class AndroidStreamController {
  private readonly handles = new Map<string, AndroidStreamHandle>()
  private readonly starts = new Map<
    string,
    { promise: Promise<EmulatorSessionInfo>; controller: AbortController }
  >()

  constructor(private readonly deps: AndroidStreamControllerDeps) {}

  async start(serial: string): Promise<EmulatorSessionInfo> {
    const inFlight = this.starts.get(serial)
    if (inFlight && !inFlight.controller.signal.aborted) {
      return inFlight.promise
    }
    const controller = new AbortController()
    const start = this.begin(serial, controller.signal, inFlight?.promise)
    const pending = { promise: start, controller }
    this.starts.set(serial, pending)
    try {
      return await start
    } finally {
      if (this.starts.get(serial) === pending) {
        this.starts.delete(serial)
      }
    }
  }

  private async begin(
    serial: string,
    signal: AbortSignal,
    previous?: Promise<EmulatorSessionInfo>
  ): Promise<EmulatorSessionInfo> {
    if (previous) {
      await previous.catch(() => {})
    }
    signal.throwIfAborted()
    if (this.handles.has(serial) && scrcpyVideoRegistry.has(serial)) {
      return androidStreamSessionInfo(serial)
    }
    this.handles.delete(serial)
    const jarPath = await this.deps.ensureJar()
    signal.throwIfAborted()
    const { info, handle } = await this.deps.startStreamSession({
      runner: this.deps.runner,
      sdk: this.deps.sdk(),
      serial,
      jarPath,
      maxSize: this.deps.maxSize
    })
    if (signal.aborted) {
      handle.close()
      signal.throwIfAborted()
    }
    this.handles.set(serial, handle)
    return info
  }

  stop(serial: string): void {
    this.starts
      .get(serial)
      ?.controller.abort(
        new EmulatorError('emulator_no_active', 'Android stream startup was stopped.')
      )
    const handle = this.handles.get(serial)
    if (handle) {
      handle.close()
      this.handles.delete(serial)
    }
  }
}
