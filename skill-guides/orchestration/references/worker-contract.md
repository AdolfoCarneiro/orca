# Worker contract

The injected preamble is authoritative. Copy its command rather than
reconstructing flags. In particular, preserve the exact executable, worker
handle, Task ID, and Dispatch ID, and keep any other flag it carries (an older
Orca host adds `--dispatch-capability`).

## Ask and resume

Use Orca `ask` whenever the coordinator must answer. Never open a local question
TUI the coordinator cannot answer.

```text
ORCA orchestration ask --from <worker_handle> --question "<question>" --options "<choice-a>,<choice-b>" --timeout-ms 600000

ORCA orchestration ask --from <worker_handle> --resume <message_id> --timeout-ms 600000
```

Each wait defaults to 600000 ms (10 minutes). `--timeout-ms` accepts a positive
integer up to 1800000 ms (30 minutes); larger values are rejected before creating
or resuming a question. For decisions that take longer, resume the same question
after each timeout.

A timeout or disconnect leaves the original question pending. Resume its
message ID; do not create a duplicate question.

## Reading coordinator follow-ups

The coordinator steers a running worker with `send --to dispatch:<id>`. That
enqueue is durable but does not interrupt you, so nothing arrives unless you
look:

```text
ORCA orchestration check --terminal <worker_handle> --json
```

Run it at each natural checkpoint — before starting a new file, after a test
run — and once more immediately before `worker_done`, so a redirect or a
cancellation lands before the Task settles. `check` names its caller with
`--terminal`, never `--from`. Stop checking after `worker_done`.

Each `check` marks the batch it returns handled; repeat until `count` is 0.
Only if a batch lacks `"deliveryAcknowledged": true` (an older Orca), ack its
`deliveryId` with `--ack`. If a `check` reply was lost, rerun it with the
`--retry-request <id>` it printed; after lost context, read handled mail with
`ORCA orchestration inbox --terminal dispatch:<dispatch_id> --limit 50 --full --json`.

Do not use `run-use` to check your Dispatch's mail or bind the Run you work for or any ancestor Run.
You may resume a separate Run when your coordinator directs a handoff, but you
cannot use `--takeover-legacy`. Plain `check` returns your Dispatch's mail
unless you are coordinating a Run; report to your coordinator with `send`.

If a plain `check` (no `--run`) returns `consumer_fenced`, this process no longer owns its Dispatch:
the Attempt was re-attached to another worker or settled without you. Stop, do
not send `worker_done`, and do not retry the check. An empty `check` never means
you were replaced; `consumer_fenced` is the only way you learn that.
If `send` or `ask` returns `consumer_fenced`, the command ran from another
party's terminal (a coordinator or another worker); run it from your own terminal.

## Helper workers

Follow the preamble's SUB-DISPATCH section. For helpers on your own
Dispatch's Run, use the commands below, without `run-create` or `run-use`; a
remote preamble may instead tell you to create your own Run.

```text
ORCA orchestration worker-start --from <worker_handle> --spec "<sub-task>" --worktree current --agent <agent> --json
ORCA orchestration reply --from <worker_handle> --id <message_id> --body "<answer>"
```

Their questions, escalations, and `worker_done` arrive in your own `check`, next
to your coordinator's mail. Answer their questions with `reply`, and wait until
every helper has settled (`worker_done`, a failed start, stop, or abandon)
before sending yours; name any that failed. After you settle, a helper
still running reports to your coordinator's Run.

## Escalation

Escalate only before completion and only when the coordinator must intervene:

```text
ORCA orchestration send --from <worker_handle> --type escalation --subject "Blocked: <reason>" --body "<details>" --task-id <task_id> --dispatch-id <dispatch_id>
```

## Completion

Send exactly one terminal report. `--body` is three sentences: what changed,
what was found, and what remains. Use `--outcome failed` when the requested work
is not complete; never hide failure in prose or silently exit.

Append `--files-modified` or `--report-path` only when applicable, using actual
paths. Do not send documentation placeholders as metadata.

```text
ORCA orchestration send --from <worker_handle> --type worker_done --subject "<short status>" --body "<three sentences: work, findings, remaining>" --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded
```

After `worker_done`, end the dispatched turn and idle (a bare-shell worker
exits, as its preamble says). Do not poll or begin unrelated work. A later direct user instruction is new
user-owned work and must not reuse settled lifecycle IDs; a supervised follow-up
arrives with a fresh preamble and Task block.
