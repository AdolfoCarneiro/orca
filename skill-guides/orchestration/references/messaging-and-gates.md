# Messaging and gates

## Reading mail

`check --run <run_id>` returns your Run's oldest batch of mail (up to 50
messages) and marks it handled; handle all of it before the next `check`.
`--peek` only looks; scripts that watch the inbox must use it. `check` takes
`--terminal <handle>`, never `--from`; an Orca terminal fills it in.

- **Lost reply.** If a `check` or other mutation's reply was lost, rerun the
  same command with the `--retry-request <id>` it printed.
- **Lost context.** Reread handled mail:
  `ORCA orchestration inbox --terminal run:<run_id> --limit 50 --full --json`
  (a worker uses `dispatch:<dispatch_id>`).

## Addresses

Steer one worker by its Dispatch, never by a terminal handle:

```text
ORCA orchestration send --to dispatch:<dispatch_id> --subject "Follow-up" --body "<guidance>" --json
```

Omit `--from` as a coordinator; a worker copies the `--from` in its preamble.

Groups reach the live workers of your own Run: `@all`, `@idle`, and one per
agent (`@claude`, `@codex`, `@opencode`, `@gemini`, `@droid`, `@grok`,
`@cursor`). `@worktree:<id>` reaches every Orca terminal in that workspace,
coordinators included. Use groups only for deliberate fan-out; `worker_done`
and other lifecycle messages never go to a group. A worker raising a blocker
sends to `run:<id>`.

## Questions and gates

A worker asks with `ask`; you answer with `reply --id <message_id>`. If its
wait times out, the question stays pending and the worker resumes it.

Use a gate only for a decision in your own Task DAG, never to answer an `ask`:

```text
ORCA orchestration gate-create --task <task_id> --question "<decision>" --options <json_array> --json
ORCA orchestration gate-resolve --id <gate_id> --resolution "<choice>" --json
ORCA orchestration gate-list --task <task_id> --json
```

## Older Orca

- A `check` batch without `"deliveryAcknowledged": true` is not marked handled;
  ack it with `check --ack <delivery_id>` or it comes back.
- A receipt without `next` means act on the result yourself; outside a wake,
  wait with `check --run <run_id> --wait --timeout-ms 540000`.
- If `worker-start --spec` fails with `run_required`, run
  `ORCA orchestration run-create --objective "<goal>" --json` first, then
  `task-create`, then `worker-start --task`.
