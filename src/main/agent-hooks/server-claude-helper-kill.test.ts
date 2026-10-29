import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
const servers: { stop: () => void }[] = []
const folders: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

it.each(['local', 'relay'])(
  'publishes the current CLI kill through the %s host and retains it on relay replay',
  async (kind) => {
    const fixture: { childPrompt: Record<string, unknown>; kill: Record<string, unknown> } =
      JSON.parse(
        await readFile(
          new URL('../../shared/__fixtures__/claude-helper-kill-2.1.310.json', import.meta.url),
          'utf8'
        )
      )
    const killedAt = Date.parse(String(fixture.kill.timestamp))
    vi.spyOn(Date, 'now').mockReturnValue(killedAt - 1_000)
    const folder = await mkdtemp(join(tmpdir(), 'claude-kill-host-'))
    folders.push(folder)
    const transcript = join(folder, 'session.jsonl')
    await writeFile(transcript, '')
    await mkdir(join(folder, 'session', 'subagents'), { recursive: true })
    await writeFile(
      join(folder, 'session', 'subagents', 'agent-a123.jsonl'),
      `${JSON.stringify(fixture.childPrompt)}\n`
    )
    const desktop = new AgentHookServer()
    servers.push(desktop)
    const relay = new RelayAgentHookServer({
      endpointDir: join(folder, 'endpoint'),
      token: 'helper-kill-test',
      forward: (envelope) => desktop.ingestRemote(envelope, 'connection')
    })
    servers.push(relay)
    await (kind === 'relay'
      ? relay.start({ publishEndpoint: false })
      : desktop.start({
          env: 'production',
          userDataPath: folder,
          endpointNamespace: 'lu-claude-helper-kill-test'
        }))
    async function post(payload: Record<string, unknown>) {
      const body = buildBody({ session_id: 'session', transcript_path: transcript, ...payload })
      if (kind === 'local') {
        expect((await postHookEvent(desktop, body)).status).toBe(204)
      } else {
        const { port, token } = relay.getCoordinates()
        expect(
          (
            await fetch(`http://127.0.0.1:${port}/hook/claude`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
              body: JSON.stringify(body)
            })
          ).status
        ).toBe(204)
      }
    }
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'work' })
    await post({ hook_event_name: 'SubagentStart', agent_id: 'a123' })
    if (kind === 'relay') {
      const baseline = desktop.getStatusSnapshotForPane(PANE)[0]
      if (!baseline) {
        throw new Error('missing live parent')
      }
      expect(
        desktop.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: baseline.prompt,
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      ).toBe(true)
    }
    await post({
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'a123', type: 'subagent', status: 'running' },
        { id: 'shell', type: 'shell', status: 'running' }
      ],
      last_assistant_message: 'READY'
    })
    expect(desktop.getStatusSnapshotForPane(PANE)[0]?.subagents?.[0]?.state).toBe('working')
    const before = desktop.getStatusSnapshotForPane(PANE)[0]
    await appendFile(transcript, `${JSON.stringify(fixture.kill)}\n`)
    await vi.waitFor(
      () => {
        expect(desktop.getStatusSnapshotForPane(PANE)[0]?.subagents ?? []).toEqual([])
      },
      { timeout: 5_000, interval: 30 }
    )
    const after = desktop.getStatusSnapshotForPane(PANE)[0]
    expect(after?.workingMode).toBe('monitoring')
    expect(after?.mainAgent).toEqual(before?.mainAgent)
    expect(after?.turnEndedAt).toBe(before?.turnEndedAt)
    if (kind === 'relay') {
      relay.replayCachedPayloadsForPanes()
      expect(desktop.getStatusSnapshotForPane(PANE)[0]?.subagents ?? []).toEqual([])
    }
  }
)
