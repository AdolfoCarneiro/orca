import '../../../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { RpcRequest } from '../../../core'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import {
  attachedRemoteWorker,
  attachRemoteDispatch,
  request
} from './federated-message-targeting.test-fixture'

describe('orchestration federated message targeting', () => {
  let db: OrchestrationDb | undefined
  let runtime: OrcaRuntimeService | undefined

  afterEach(() => {
    runtime?.stopOrchestrationFederationRelay()
    db?.close()
  })

  it('keeps home-only send and ask target refusals while local targets use ordinary errors', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    const dispatchId = 'ctx_remote_targeting'
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const requests: RpcRequest[] = [
      request('send_to', 'orchestration.send', {
        from: 'term_remote_worker',
        to: 'run:explicit',
        subject: 'Wrong explicit target'
      }),
      request('send_run', 'orchestration.send', {
        from: 'term_remote_worker',
        run: 'run_explicit',
        subject: 'Wrong explicit Run'
      }),
      request('ask_to', 'orchestration.ask', {
        from: 'term_remote_worker',
        to: 'run:explicit',
        question: 'Wrong explicit target?'
      }),
      request('ask_run', 'orchestration.ask', {
        from: 'term_remote_worker',
        run: 'run_explicit',
        question: 'Wrong explicit Run?'
      })
    ]

    for (const item of requests) {
      await expect(dispatcher.dispatch(item)).resolves.toMatchObject({
        ok: false,
        error:
          item.id === 'rpc_send_to'
            ? { code: 'run_not_found' }
            : {
                code: 'invalid_argument',
                message: 'Federated Dispatch messages route to their Run home; omit --to and --run.'
              }
      })
    }
    expect(
      db.listFederationRelay({ dispatchId, direction: 'to_home', afterSequence: 0 })
    ).toHaveLength(0)
  })

  it('delivers explicit local terminal mail without using admitted sender provenance as scope', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_peer' ? 'tab_peer:leaf_peer' : null
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const payload = JSON.stringify({ dispatchId: 'ctx_remote_targeting', note: 'unchanged' })
    const mail = request('local_peer', 'orchestration.send', {
      from: 'term_remote_worker',
      to: 'term_peer',
      subject: 'Hello peer',
      payload
    })
    const sent = await dispatcher.dispatch(mail)
    expect(sent).toMatchObject({
      ok: true,
      result: {
        message: {
          from_handle: 'term_remote_worker',
          to_handle: 'term_peer',
          run_id: 'run_unbound',
          payload
        },
        warnings: [{ code: 'legacy_terminal_recipient' }]
      }
    })
    expect(await dispatcher.dispatch(mail)).toMatchObject({
      ok: true,
      result: { mutation: { replayed: true }, message: { payload, to_handle: 'term_peer' } }
    })
    expect(db.getInbox()).toHaveLength(1)
    expect(
      db.listFederationRelay({
        dispatchId: 'ctx_remote_targeting',
        direction: 'to_home',
        afterSequence: 0
      })
    ).toEqual([])
    await expect(
      dispatcher.dispatch(
        request('spoofed_dispatch', 'orchestration.send', {
          from: 'term_remote_worker',
          to: 'term_peer',
          subject: 'Wrong source',
          payload: JSON.stringify({ dispatchId: 'ctx_other' })
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'dispatch_inactive' } })
    expect(db.getInbox()).toHaveLength(1)
  })

  it('uses ordinary Run, Dispatch and nested coordinator destinations, conflicts and final mirror refusal', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    const owner = db
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const peerPane = 'tab_peer:leaf_peer'
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_peer' ? peerPane : null
    )
    const parent = db.createRun({
      objective: 'parent',
      coordinatorHandle: 'term_parent',
      coordinatorPaneKey: 'tab_parent:leaf_parent'
    })
    const child = db.createRun({
      objective: 'child',
      coordinatorHandle: 'term_peer',
      coordinatorPaneKey: peerPane
    })
    const dispatch = createRootDispatch(
      db,
      db.createTask({ runId: parent.id, spec: 'nested lead' }).id,
      'term_peer',
      peerPane,
      undefined,
      'worker_epoch:pty:1'
    )
    for (const [id, to, run] of [
      ['run', `run:${child.id}`, undefined],
      ['terminal', 'term_peer', undefined],
      ['dispatch', `dispatch:${dispatch.id}`, undefined],
      ['explicit_parent', `dispatch:${dispatch.id}`, parent.id]
    ]) {
      await expect(
        dispatcher.dispatch(
          request(`local_${id}`, 'orchestration.send', {
            from: 'term_remote_worker',
            to,
            run,
            subject: 'Nested hello',
            payload: JSON.stringify({ dispatchId: 'ctx_remote_targeting', taskId: 'sender_task' })
          })
        )
      ).resolves.toMatchObject({
        ok: true,
        result: { message: { to_handle: `run:${child.id}`, run_id: child.id } }
      })
    }
    await expect(
      dispatcher.dispatch(
        request('conflict', 'orchestration.send', {
          from: 'term_remote_worker',
          to: 'term_peer',
          run: parent.id,
          subject: 'Conflict'
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'recipient_run_mismatch' } })
    // The Run owner can be a remote mirror even when no Run was explicitly named.
    owner.db.prepare("UPDATE runs SET home_database = 'remote' WHERE id = ?").run(child.id)
    for (const [id, to] of [
      ['bare_mirror', 'term_peer'],
      ['nested_mirror', `dispatch:${dispatch.id}`]
    ]) {
      await expect(
        dispatcher.dispatch(
          request(id, 'orchestration.send', {
            from: 'term_remote_worker',
            to,
            subject: 'Do not strand mirror mail'
          })
        )
      ).resolves.toMatchObject({ ok: false, error: { code: 'run_home_unreachable' } })
    }
    expect(db.getInbox()).toHaveLength(4)
    expect(
      db.listFederationRelay({
        dispatchId: 'ctx_remote_targeting',
        direction: 'to_home',
        afterSequence: 0
      })
    ).toEqual([])
  })

  it('keeps ordinary ambiguity, missing recipient and settled Dispatch refusals effect-free', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const runId = db.createRun({
      objective: 'local work',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    }).id
    const first = createRootDispatch(db, db.createTask({ runId, spec: 'one' }).id, 'term_exact')
    db.createRun({
      objective: 'First historical owner',
      coordinatorHandle: 'term_ambiguous',
      coordinatorPaneKey: 'tab_first:leaf_first'
    })
    db.createRun({
      objective: 'Second historical owner',
      coordinatorHandle: 'term_ambiguous',
      coordinatorPaneKey: 'tab_second:leaf_second'
    })
    const closed = createRootDispatch(
      db,
      db.createTask({ runId, spec: 'closed' }).id,
      'term_closed'
    )
    db.completeDispatch(closed.id)
    for (const [id, to, code] of [
      ['missing', 'term_missing', 'terminal_not_found'],
      ['ambiguous', 'term_ambiguous', 'recipient_ambiguous'],
      ['closed', `dispatch:${closed.id}`, 'dispatch_inactive']
    ]) {
      await expect(
        dispatcher.dispatch(
          request(id, 'orchestration.send', {
            from: 'term_remote_worker',
            to,
            subject: 'No fallback'
          })
        )
      ).resolves.toMatchObject({ ok: false, error: { code } })
    }
    await expect(
      dispatcher.dispatch(
        request('explicit_dispatch', 'orchestration.send', {
          from: 'term_remote_worker',
          to: `dispatch:${first.id}`,
          subject: 'Choose exactly'
        })
      )
    ).resolves.toMatchObject({
      ok: true,
      result: { message: { to_handle: `dispatch:${first.id}` } }
    })
    expect(db.getInbox()).toHaveLength(1)
  })

  it.each(['worker_done', 'heartbeat', 'escalation', 'decision_gate'] as const)(
    'keeps %s at home and refuses conflicting local recipients',
    async (type) => {
      ;({ db, runtime } = attachedRemoteWorker())
      const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
      const params = {
        from: 'term_remote_worker',
        type,
        subject: 'Report',
        payload: JSON.stringify({ outcome: 'succeeded' })
      }
      await expect(
        dispatcher.dispatch(
          request(`local_${type}`, 'orchestration.send', { ...params, to: 'term_peer' })
        )
      ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
      await expect(
        dispatcher.dispatch(request(`home_${type}`, 'orchestration.send', params))
      ).resolves.toMatchObject({ ok: true, result: { relay: { destination: 'run_home' } } })
      expect(db.getInbox()).toEqual([])
      expect(
        db
          .listFederationRelay({
            dispatchId: 'ctx_remote_targeting',
            direction: 'to_home',
            afterSequence: 0
          })
          .map((row) => row.kind)
      ).toEqual([type])
    }
  )

  it.each([
    'dispatch:ctx_remote_targeting',
    '@all',
    '@worktree:repo::remote-worktree',
    'task:task_remote_targeting'
  ])('retains the existing attached refusal for %s', async (to) => {
    ;({ db, runtime } = attachedRemoteWorker())
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    await expect(
      dispatcher.dispatch(
        request('nonindividual', 'orchestration.send', {
          from: 'term_remote_worker',
          to,
          subject: 'Unchanged'
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(db.getInbox()).toEqual([])
    expect(db.listPendingFederationRelay('ctx_remote_targeting', 'to_home')).toEqual([])
  })

  it('delivers a send that names its own Run home to that home', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    for (const [id, target] of [
      ['home_to', { to: 'run:run-home' }],
      ['home_run', { run: 'run-home' }]
    ] as const) {
      await expect(
        dispatcher.dispatch(
          request(id, 'orchestration.send', {
            from: 'term_remote_worker',
            ...target,
            subject: 'Progress'
          })
        )
      ).resolves.toMatchObject({ ok: true })
    }
    await expect(
      dispatcher.dispatch(
        request('home_ask', 'orchestration.ask', {
          from: 'term_remote_worker',
          to: 'run:run-home',
          question: 'Which branch?',
          timeoutMs: 0
        })
      )
    ).resolves.toMatchObject({ ok: true, result: { timedOut: true } })
    expect(
      db
        .listFederationRelay({
          dispatchId: 'ctx_remote_targeting',
          direction: 'to_home',
          afterSequence: 0
        })
        .map((item) => item.kind)
    ).toEqual(['status', 'status', 'question'])
    expect(db.getInbox()).toHaveLength(0)
  })

  it('refuses a Run a remote Dispatch here reports to once the link to it is lost', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    // The agent now runs in a pane its remote Dispatch was never attached to.
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_other:leaf_other')
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    for (const [id, target] of [
      ['lost_to', { to: 'run:run-home' }],
      ['lost_run', { run: 'run-home' }]
    ] as const) {
      await expect(
        dispatcher.dispatch(
          request(id, 'orchestration.send', {
            from: 'term_remote_worker',
            ...target,
            type: 'worker_done',
            subject: 'Done',
            payload: JSON.stringify({ outcome: 'succeeded' })
          })
        )
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'run_home_unreachable',
          message:
            "Run run-home lives on the computer that coordinates it, which isn't reachable from here: this terminal is no longer attached to its Dispatch ctx_remote_targeting. Nothing was sent."
        }
      })
    }
    expect(db.getInbox()).toHaveLength(0)
    expect(
      db.listFederationRelay({
        dispatchId: 'ctx_remote_targeting',
        direction: 'to_home',
        afterSequence: 0
      })
    ).toHaveLength(0)
  })

  it('still delivers to a local Run no remote Dispatch reports to', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_other:leaf_other')
    const local = db.createRun({
      objective: 'local run',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:leaf_coordinator'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    await expect(
      dispatcher.dispatch(
        request('local_to', 'orchestration.send', {
          from: 'term_local_sender',
          to: `run:${local.id}`,
          subject: 'Hello'
        })
      )
    ).resolves.toMatchObject({ ok: true })
    expect(db.getInbox().map((message) => message.to_handle)).toEqual([`run:${local.id}`])
  })

  it('delivers to a local Run a loopback remote Dispatch also reports to', async () => {
    const loopbackDb = new OrchestrationDb(':memory:')
    db = loopbackDb
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(loopbackDb)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_coordinator:leaf_coordinator')
    const local = loopbackDb.createRun({
      objective: 'loopback run',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:leaf_coordinator'
    })
    attachRemoteDispatch(loopbackDb, runtime, local.id)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    await expect(
      dispatcher.dispatch(
        request('loopback_run', 'orchestration.send', {
          from: 'term_coordinator',
          run: local.id,
          subject: 'Hello'
        })
      )
    ).resolves.toMatchObject({ ok: true })
    expect(loopbackDb.getInbox().map((message) => message.run_id)).toEqual([local.id])
  })

  it('answers coordinator mail at the Run home, or refuses once the link is lost', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    const mirrorDb = db
    const coordinatorMail = mirrorDb.insertMessage({
      id: 'msg_home_control',
      runId: 'run-home',
      from: 'term_coordinator',
      to: 'dispatch:ctx_remote_targeting',
      subject: 'Status?',
      body: 'How far along?'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    await expect(
      dispatcher.dispatch(
        request('reply_linked', 'orchestration.reply', {
          from: 'term_remote_worker',
          id: coordinatorMail.id,
          body: 'Halfway.'
        })
      )
    ).resolves.toMatchObject({ ok: true, result: { message: { subject: 'Re: Status?' } } })
    const relayed = mirrorDb.listFederationRelay({
      dispatchId: 'ctx_remote_targeting',
      direction: 'to_home',
      afterSequence: 0
    })
    expect(relayed.map((item) => JSON.parse(item.payload).threadId)).toEqual([coordinatorMail.id])

    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_other:leaf_other')
    await expect(
      dispatcher.dispatch(
        request('reply_lost', 'orchestration.reply', {
          from: 'term_remote_worker',
          id: coordinatorMail.id,
          body: 'Done.'
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'run_home_unreachable' } })
    expect(mirrorDb.getInbox().map((message) => message.id)).toEqual([coordinatorMail.id])
  })

  it("refuses a reply to mail sent to another worker's Dispatch of the same Run", async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    const mirrorDb = db
    const otherWorkerMail = mirrorDb.insertMessage({
      id: 'msg_home_other_worker',
      runId: 'run-home',
      from: 'term_coordinator',
      to: 'dispatch:ctx_other_worker',
      subject: 'Status?',
      body: 'How far along?'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    await expect(
      dispatcher.dispatch(
        request('reply_other', 'orchestration.reply', {
          from: 'term_remote_worker',
          id: otherWorkerMail.id,
          body: 'Not mine.'
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'run_home_unreachable' } })
    expect(
      mirrorDb.listFederationRelay({
        dispatchId: 'ctx_remote_targeting',
        direction: 'to_home',
        afterSequence: 0
      })
    ).toHaveLength(0)
  })
})
