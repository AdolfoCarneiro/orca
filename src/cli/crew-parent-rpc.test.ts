import '../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { dispatch } from './dispatch'
import { RuntimeClient, RuntimeClientError } from './runtime-client'
import { ORCHESTRATION_CONTRACT_VERSION } from '../shared/protocol-version'
import {
  createSessionCallerHarness,
  orchestrationRequest
} from '../main/runtime/rpc/orchestration-session-caller-test-fixture'
import { configureFederationWorkerRuntime } from '../main/runtime/rpc/methods/orchestration/federation/federation-runtime.test-support'
import { buildCrewSnapshot } from '../main/runtime/orchestration/crew/crew-read-model'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../main/native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('composes actual local and paired RPC claims in either order and preserves detached CLI refusal', async () => {
  for (const order of ['local-first', 'remote-first']) {
    const h = createSessionCallerHarness(hostRef)
    try {
      vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
      vi.stubEnv('ORCA_PANE_KEY', '')
      configureFederationWorkerRuntime(h.runtime)
      vi.spyOn(h.runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
      const pane = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      const handle = 'term_windows_worker'
      const coordinatorPane = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      vi.mocked(h.runtime.getTerminalPaneKey).mockImplementation((value) =>
        value === 'term_coord' ? coordinatorPane : value === handle ? pane : null
      )
      const run = h.db.createRun({
        objective: 'Local manager',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: coordinatorPane
      })
      const task = h.db.createTask({ runId: run.id, spec: 'Existing terminal' })
      h.db.updateTaskStatus(task.id, 'ready')
      const local = () =>
        h.dispatch(
          orchestrationRequest('orchestration.dispatch', {
            from: 'term_coord',
            run: run.id,
            task: task.id,
            to: handle,
            inject: false
          })
        )
      const remote = () =>
        h.dispatch(
          orchestrationRequest('orchestration.federationAttachStart', {
            dispatchId: 'ctx_remote_parent',
            runId: 'run_remote_home',
            taskId: 'task_remote_parent',
            taskSpec: 'Paired worker',
            protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
            worktree: 'new-top-level',
            repo: 'id:windows-repo',
            name: 'worker',
            agent: 'codex'
          })
        )
      const results =
        order === 'local-first' ? [await local(), await remote()] : [await remote(), await local()]
      for (const result of results) {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
      }
      const deps = {
        db: h.db,
        hostKey: 'local',
        retainedDbExists: true,
        records: null,
        statuses: [],
        liveHandle: (value: string) => value === handle || value === 'term_coord',
        handleForPane: (value: string) => (value === pane ? handle : null),
        paneForHandle: (value: string) => (value === handle ? pane : null),
        name: () => 'Manager'
      }
      const parents = buildCrewSnapshot(handle, deps).sections.managedBy
      expect(parents.map((row) => row.sendAddress).sort()).toEqual(
        ['term_coord', 'run:run_remote_home'].sort()
      )
      expect(
        parents.find((row) => row.sendAddress === 'run:run_remote_home')?.openTarget
      ).toBeUndefined()
      const client = new RuntimeClient('/tmp/crew-parent-routing', 1000, null, null)
      vi.spyOn(client, 'call').mockImplementation(async (method: string, params: unknown) => {
        const response = await h.dispatch(
          orchestrationRequest(method, z.record(z.string(), z.unknown()).parse(params))
        )
        if (!response.ok) {
          throw new RuntimeClientError(response.error.code, response.error.message)
        }
        return {
          ...response,
          result: response.result,
          _meta: { runtimeId: 'crew-parent-test' }
        }
      })
      await expect(
        dispatch(['orchestration', 'send'], {
          client,
          flags: new Map([
            ['from', 'term_detached'],
            ['to', 'run:run_remote_home'],
            ['subject', 'Detached parent'],
            ['body', 'Hello']
          ]),
          cwd: '/tmp',
          json: true
        })
      ).rejects.toMatchObject({ code: 'run_home_unreachable' })
      expect(
        h.db.db.prepare("SELECT sequence FROM messages WHERE subject = 'Detached parent'").all()
      ).toEqual([])
    } finally {
      h.close()
    }
  }
})
