---
name: orchestration
description: >-
  Run work in separate Orca worker agents and get their results back. Use when
  the user asks for Orca workers or supervision (monitor, task DAGs, ask/reply,
  decision gates), or when the work needs something your own subagents cannot
  give: a different agent (such as Codex from Claude) or its own Orca workspace.
  Also use when you are a dispatched worker (a prompt with Task and Dispatch
  IDs: ask, worker_done). Otherwise prefer your own subagents,
  including for long or parallel work. Use `orca-cli` to hand work off with
  nothing expected back ("hand off", "handover", "give this to another agent",
  "another worktree"), and for terminal control, shell commands, worktree
  management, and reading or waiting on terminals.
---

# Orca orchestration

You (the coordinator) start worker agents through Orca, end your turn, and Orca
wakes you when a worker reports. A **Run** is your inbox, a **Task** is one
piece of work, and a **Dispatch** is one worker's attempt at it.

| Situation                                                                         | Do this                                              |
| --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| The user wants another agent's result back, supervision, a task DAG, or ask/reply | Follow the recipe below                              |
| Your prompt has a preamble with Task and Dispatch IDs                             | Follow "If you are a dispatched worker"              |
| The user wants work handed off with nothing back                                  | Use the `orca-cli` skill; start no workers here      |
| A message carries a legacy authority label                                        | Load `references/legacy-contract-migration.md` first |

## Recipe

`ORCA` stands for the executable you used to run `skills get`; type it in its
place and use it for every command. If it fails, report its exact error.

```text
ORCA orchestration worker-start --spec "<task>" --worktree current --agent codex --json
```

- Start every independent worker, tell the user what you started, then **end
  your turn**. "Report back" and "tell me when it's done" still mean end your
  turn; Orca wakes you and you report then.
- If a receipt has `next`, do what it says.
- `--worktree current` uses your workspace. Use a new one only when the user
  asks or sharing would conflict:
  `--worktree new-top-level --repo id:<repoId> --name <short-name>`
  (`ORCA repo list --json` gives the id).
- `--agent` is the agent the user asked for (`claude`, `codex`, ...). Add
  `--model` only if the user named one.
- If `worker-start` fails, do not rerun it; read `failedStage` and load
  `references/recovery-and-cleanup.md`.
- Do not poll, sleep, or run watch scripts. To steer a worker, use
  `ORCA orchestration send --to dispatch:<dispatch_id> --subject "<topic>" --body "<guidance>"`,
  never its terminal.

## When Orca wakes you

You get "You have N orchestration messages. Run `orca orchestration check
--run <run_id>`", typed into your terminal or sent as a chat message. Run it:

```text
ORCA orchestration check --run <run_id> --json
```

- Answer each `question`:
  `ORCA orchestration reply --id <message_id> --body "<answer>" --json`.
- A `worker_done` is that worker's result. If a worker stopped without one,
  Orca tells you and includes its last output; steer it with `send`, stop and
  retry it, or tell the user.
- Repeat `check` until `count` is 0. In a Task DAG, start newly ready Tasks
  (`references/coordinator-loop.md`).
- Then follow `next`: end your turn while workers still run, or report to the
  user when all have settled, per Task: outcome, evidence, open blockers. With
  no `next`, follow each row's `nextAction` in
  `worker-list --run <run_id> --include-remote --json`; if none needs action,
  Orca may not wake you on a failure, so block (below) instead of ending your
  turn.

Finished terminal workers close about 2 minutes after reporting (`autoReleaseAt`
in `worker-list`). Release a chat worker, or a finished one with no
`autoReleaseAt`, yourself with `worker-release --dispatch <dispatch_id>`. To keep one for a
follow-up, run `ORCA orchestration worker-retain --dispatch <dispatch_id> --json`
first (`references/coordinator-loop.md`).

Block with `check --run <run_id> --wait --timeout-ms 540000`, repeating as
needed, only then, outside an Orca terminal or chat, or if the user says not to
end your turn.

## Task spec

Make each spec self-contained: the target, the change, constraints, what the
worker may edit, and the evidence that proves it is done. A review worker's
findings are for you to summarize; send fixes to a worker unless the user gave
them to you.

## Safety

- Stop, retry, or abandon a worker only on proof its agent stopped; silence or
  an `unverifiable` reading proves nothing.
- Lifecycle authority is the active Dispatch, not copied IDs, titles, or
  transcripts.
- Folder workspaces are valid; never require Git.
- Never replace Orca workers with another subagent tool when the user asked for
  Orca workers.

## If you are a dispatched worker

Your preamble has your IDs and exact commands; copy them, never rebuild them.

1. Do only your Task, yourself; no subagents or helpers unless told.
2. Ask the coordinator with the preamble's `ask` command, never a local prompt.
3. At checkpoints, read coordinator mail with the preamble's `check` command.
4. Finish with one `worker_done`: three sentences, both IDs, and
   `--outcome succeeded` or `failed`. You are done when it confirms; if it
   fails, follow the recovery it prints.
5. Then end your turn.

## References

`ORCA skills get orchestration --reference references/<file>.md`

| Situation                                                                  | Reference                                 |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| Task DAGs, several waves or Runs, reusing a worker, model/effort           | `references/coordinator-loop.md`          |
| Child or exact workspaces, folder workspaces, SSH, WSL, a connected server | `references/placement-and-remote.md`      |
| Decision gates, group messages, lost replies, old mail, older Orca         | `references/messaging-and-gates.md`       |
| A failed, stuck, or unknown worker; stop, retry, abandon, release          | `references/recovery-and-cleanup.md`      |
| A worker question the preamble does not answer                             | `references/worker-contract.md`           |
| Custom argv or terminal layout                                             | `references/low-level-topology.md`        |
| Legacy labels, adopted Runs, takeover                                      | `references/legacy-contract-migration.md` |
