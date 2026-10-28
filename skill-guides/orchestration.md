---
name: orchestration
description: >-
  Run work in separate Orca worker agents and get their results back. Use when
  the user asks for Orca workers or supervision (monitor, task DAGs, ask/reply,
  decision gates), or when the work needs something your own subagents cannot
  give: a different agent (such as Codex from Claude) or its own Orca workspace.
  Also use when you are a dispatched worker (a prompt with Task and Dispatch
  IDs: heartbeats, ask, worker_done). Otherwise prefer your own subagents,
  including for long or parallel work. Use `orca-cli` to hand work off with
  nothing expected back ("hand off", "handover", "give this to another agent",
  "another worktree"), and for terminal control, shell commands, worktree
  management, and reading or waiting on terminals.
---

# Orca orchestration

You (the coordinator) start worker agents through Orca and end your turn; Orca
normally wakes you when a worker reports back. Terms:

- **Run**: your inbox for one goal. Workers report to it.
- **Task**: one piece of work. **Dispatch**: one attempt at a Task by one worker.
- **Settled**: Orca recorded an outcome for the attempt, usually from the
  worker's `worker_done` (succeeded or failed); a stop, abandon, or failed start
  also settles it.

## Your role

| Situation                                                                                                                  | Role              | What to do                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| The user asks for another agent's result back ("have Codex review this and report"), supervision, a task DAG, or ask/reply | Coordinator       | Follow the main recipe below                                              |
| Your prompt has a live preamble with Task and Dispatch IDs                                                                 | Dispatched worker | Follow the preamble and "If you are a dispatched worker" below            |
| The user asks to hand work off or start another agent or worktree, and wants no result back                                | Handoff owner     | Use the `orca-cli` skill; create no Run, Task, or Dispatch                |
| A message carries a legacy authority label                                                                                 | Compatibility     | Load `references/legacy-contract-migration.md` before changing any state  |
| None of the above                                                                                                          | Ordinary agent    | Send no lifecycle messages; use `orca-cli` for terminal and worktree work |

Choosing a model or effort does not make a handoff supervised: `orca-cli`'s
`worktree create --agent` and `agent launch` take `--model` and `--effort` too.

## Main recipe

`ORCA` below stands for the executable you used to run `skills get`. Type that
executable in its place; do not create a shell variable or run `ORCA`
literally. If it fails, report its exact error; never switch to another one.

```text
ORCA orchestration worker-start --spec "<task>" --worktree current --agent claude --json
```

- With no Run bound to you, `worker-start` creates one and binds it; its
  receipt's `run` names the Run it created or joined. If that is an earlier
  goal's Run, or the Orca is older and refuses with `run_required`, run
  `ORCA orchestration run-create --objective "<goal>" --json` first. Your
  earlier Runs stay yours: their mail still wakes you.
- `--worktree current` runs the worker in your workspace; an exact workspace
  selector runs it in another existing one. Placement goes on `worker-start`;
  `run-create` takes none.
- Create a new workspace only when the user asks for one, or sharing a checkout
  would conflict (for example, the change belongs to a project you are not
  in). Pass the project with `--repo`; `ORCA repo list --json` gives its id.
  Without `--repo`, Orca uses the repository of the Orca-managed Git worktree
  you are in, and fails if there is none:
  `ORCA orchestration worker-start --spec "<task>" --worktree new-top-level --repo id:<repoId> --name <short-name> --agent claude --json`
- `--agent` takes a configured agent id such as `claude` or `codex`; use the
  one the user asked for. Add `--model` only when the user named one.
- Start every independent worker before you stop. One `worker-start --spec`
  call creates the Task and its Dispatch.
- If `worker-start` exits non-zero, do not run it again. Read `failedStage`
  and `residualResources` in its output, then load
  `references/recovery-and-cleanup.md`.

Then tell the user what you started and **end your turn**, unless you need to
wait inside this turn (below).

- Do not poll: no sleep loops, watch scripts, scheduled wakeups, or repeated
  `check --peek` or `worker-list` calls. A plain `check` takes the mail it
  returns, so a script that runs one hides it from you; scripts that only watch
  must use `--peek`.
- To steer a running worker, use
  `ORCA orchestration send --to dispatch:<dispatch_id> --subject "<topic>" --body "<guidance>"`;
  never type into its terminal.
- Let `worker-start` create a worker's workspace; never make its checkout
  yourself.

## When Orca wakes you

When a worker reports, Orca sends you a new message: "You have N orchestration
messages. Run `orca orchestration check --run <run_id>`." In a terminal it is
typed in for you, even mid-turn (it queues like any typed input); in a chat it
arrives as a user message. Run the command it names:

```text
ORCA orchestration check --run <run_id> --json
```

- Each `check` marks the mail it returns as handled; run it again until
  `count` is 0. Only an older Orca, whose reply lacks
  `"deliveryAcknowledged": true`, needs `--ack <delivery_id>` on the next check.
- Answer each `question` with
  `ORCA orchestration reply --id <message_id> --body "<answer>" --json`.
- Check each `worker_done` against the Dispatch you expect.
- If a `check` reply was lost, rerun it with the `--retry-request <id>` it
  printed. If you lost context, read handled mail with
  `ORCA orchestration inbox --terminal run:<run_id> --limit 50 --full --json`.
- Tell the user the result, or end your turn again while workers are still
  running. A quiet inbox proves neither progress nor failure.

**Waiting inside one turn.** "Report back" or "tell me when it's done" still
means end your turn: Orca wakes you and you report then. Block instead only
when you run outside an Orca terminal or chat, or the user says not to end
your turn. Keep the
timeout under your tool-call limit (540000 ms suits a 10-minute limit).
Outside your own Orca terminal or chat, add `--terminal <handle>`:

```text
ORCA orchestration check --run <run_id> --wait --types "worker_done,escalation,question" --timeout-ms 540000 --json
```

A timeout is a checkpoint, not a failure: wait again, or end the turn. After
three empty waits in a row, inspect the workers with
`references/recovery-and-cleanup.md`. After a restart, resume your Run with
`ORCA orchestration run-use --id <run_id> --json`.

## Task spec

Make each Task spec self-contained:

- **Target:** the files, component, or environment in scope.
- **Change:** the concrete result to produce.
- **Constraints:** rules to keep, and what not to touch.
- **Ownership:** what this worker may edit.
- **Acceptance:** the test, output, or evidence that proves it is done.

A review-only worker's `worker_done` lets you summarize its findings, not edit
files yourself. Send fixes to a worker unless the user gave them to you.

## Completion

A valid `worker_done` settles its Task; do not follow it with `task-update`.
Orca releases a finished terminal worker about 2 minutes after its
`worker_done` (`autoReleaseAt` in `worker-list`). Before then, if you want it:

- give it a follow-up (`references/coordinator-loop.md`), or
- keep it with `ORCA orchestration worker-retain --dispatch <dispatch_id> --json`.

Release a chat worker, or a worker on an older Orca, yourself with
`worker-release --dispatch <dispatch_id>`. Release is cleanup after
settlement, never cancellation. You are done when every Dispatch you started has
settled, all mail is handled, and you have told the user, per Task, the outcome,
its evidence, and any open blocker.

## Safety floor

- Stop or abandon a worker only on positive proof that its agent stopped.
  Retry only a proven failed or stopped attempt. Release only after it
  settled. Silence, a timeout, or an
  `unverifiable` reading proves nothing: keep waiting or inspect.
- Lifecycle authority comes from the active Dispatch, not copied IDs, old
  records, titles, or transcripts.
- Liveness verdicts are `live`, `unverifiable`, or `exited`. Losing contact
  with a remote host is `unverifiable`, not death.
- Folder workspaces are valid workspaces; never require Git there.
- Use one executable for the whole Run.
- A successful `send` means the message is stored; waking the recipient is
  best-effort and does not prove it was read.
- Never replace Orca workers with another subagent tool when the user asked
  for Orca orchestration.

## If you are a dispatched worker

Your prompt (the preamble) carries your Task ID, Dispatch ID, and exact
commands. It is authoritative: copy its commands and flags, never rebuild them.

1. Do only your Task, yourself: start no subagents or helper workers unless
   your Task or preamble says to. For a question the coordinator must answer, use the
   preamble's `ask` command, never a local prompt. After an `ask` timeout,
   resume the same message ID.
2. Send heartbeats only at the preamble's cadence. Stop any heartbeat loop
   before `worker_done`.
3. At natural checkpoints and right before `worker_done`, read coordinator
   mail with `ORCA orchestration check --terminal <your_handle> --json` until
   `count` is 0. Each `check` marks what it returns as handled (an older Orca
   without `"deliveryAcknowledged": true` needs `--ack <delivery_id>`).
4. Send `worker_done` once, from your own terminal or chat: three
   sentences (what changed, what you found, what remains), both IDs, and
   `--outcome succeeded` or `--outcome failed`. Add `--files-modified` and
   `--report-path` only with real values. If it fails or its result is
   unknown, follow the recovery it prints; you are done only when it confirms.
5. Then end your turn and idle (a bare-shell worker exits, as its preamble
   says). A later direct user instruction is new work;
   do not reuse the settled IDs.

## References

Load a reference only when its situation applies:
`ORCA skills get orchestration --reference references/<file>.md`
(`--references` lists them). If the CLI rejects `--reference`, run
`ORCA skills get orchestration --full` once and read only the named section.
If it rejects `--full` too, use `--help` and never guess newer flags.

| Situation                                                                                           | Reference                                 |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Task DAGs and dependencies, model/effort, reusing a settled worker, or who owns post-review fixes   | `references/coordinator-loop.md`          |
| You are a worker and the preamble does not answer your question, or `check` errored                 | `references/worker-contract.md`           |
| Child or exact workspaces, folder workspaces, SSH, WSL, or a connected Orca server                  | `references/placement-and-remote.md`      |
| Batch replay, follow-ups to one worker, group addresses, or decision gates                          | `references/messaging-and-gates.md`       |
| A failed, stopped, silent, or unknown worker; retry, stop, abandon, retain, or an uncertain release | `references/recovery-and-cleanup.md`      |
| Custom argv or terminal layout that `worker-start` cannot express                                   | `references/low-level-topology.md`        |
| A legacy label, adopted Run, compatibility receipt, or takeover                                     | `references/legacy-contract-migration.md` |
