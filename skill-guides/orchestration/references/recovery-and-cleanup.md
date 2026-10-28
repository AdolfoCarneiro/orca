# Recovery and cleanup

Act only on proof. When you cannot tell, keep the work and report it as
unknown.

| What you can prove         | Do this                                                 |
| -------------------------- | ------------------------------------------------------- |
| Running, or `unverifiable` | Wait or inspect; never stop, retry, abandon, or release |
| `failed` or `stopped`      | Retry with `--retry-of`, placement stated again         |
| `outcome_unknown`          | Inspect, then choose `worker-stop` or `worker-abandon`  |
| `exited` agent             | Follow the row's `nextAction` in `worker-list`          |

## Inspect

```text
ORCA orchestration worker-list --run <run_id> --include-remote --json
ORCA orchestration worker-show --dispatch <dispatch_id> --json
ORCA orchestration worker-read --dispatch <dispatch_id> --limit 50 --json
```

`worker-list` decides whether an agent is alive (`projection.liveness`) and
what to do (`projection.nextAction`). Without `--include-remote`, remote rows
read `unverifiable`. Past 100 rows, page with `--cursor <page.nextCursor>`.

`worker-show`'s `observation.status` covers only the terminal, so a `live`
terminal can hold a dead agent. But when the list row is `unverifiable` with
`missing_status`, `host_unavailable`, or `capability_unsupported`, a
`worker-show` verdict from the execution host is better evidence.

`worker-read` continues with its cursor; on `source_changed`, start over
without it, and check `contentComplete` before assuming older output exists.
Never guess a session ID, transcript path, or remote terminal handle.

## Proof that a worker stopped

An `escalation` with `stopReason` means Orca saw the worker end its turn, or
stop at a prompt, without `worker_done`; it carries the last output and the
Dispatch stays open. Answer with `send --to dispatch:<id>`, retry, or
`worker-stop`. `exited` liveness is also proof. Silence, an unchanged
`worker-read`, and `unverifiable` prove nothing.

## Was the mutation applied?

If a mutation's reply was lost, ask before rerunning:

```text
ORCA orchestration request-show --request <request_id> --json
```

`completed`: it took effect; use its receipt. `pending`: rerun the same command
with `--retry-request <request_id>`. `absent`: unknown; inspect the Task,
Dispatch, and terminal before retrying.

If a terminal took input but the submit is unconfirmed, use
`terminal send --wait-submit <seconds>`; it never resends.

## Refused starts

Read `error.code`; `error.data.nextSteps`, when present, is the exact fix.

| Code                 | Fix                                                                         |
| -------------------- | --------------------------------------------------------------------------- |
| `task_not_found`     | Check `task-list --json`; create the Task if missing                        |
| `task_not_startable` | Wait for dependencies, or fix the failed one; a bad `--retry-of` lands here |
| `inject_rejected`    | Start a known agent in that terminal, or skip `--inject`                    |
| `runtime_error`      | Read the message and inspect; never rerun unchanged                         |

A start that failed before its agent was ready still owns its terminal; release
it with the `worker-release` its receipt names, never `terminal close`.

## Retry, stop, abandon

Retry by naming the Task (`--spec` would create a new one). Placement is not
inherited:

```text
ORCA orchestration worker-start --task <task_id> --retry-of <dispatch_id> --worktree <placement> --agent <agent> --json
```

Three failed starts fail the Task and refuse further retries; tell the user
rather than working around it with a new Run or Task.

```text
ORCA orchestration worker-stop --dispatch <dispatch_id> --json
ORCA orchestration worker-abandon --dispatch <dispatch_id> --json
```

`worker-stop` closes only that worker's agent terminal, never the workspace or
other terminals. Its `processAction` is `closed_agent_terminal` (do not also
`terminal close`), `none`, or `unknown`. `stop_unknown` exits 1; check
`worker-show` before acting again. `worker-abandon` only ends Orca's tracking;
it touches no process or file and keeps the terminal open.

To cancel a Task, stop or abandon its worker, then:

```text
ORCA orchestration task-update --id <task_id> --status failed --result cancelled --json
```

Its dependents stay blocked until a `--retry-of` replacement succeeds.

## Retain and release

Finished terminal workers close themselves about 2 minutes after `worker_done`;
Orca saves their output first. `worker-retain` keeps one open; `worker-release`
closes a chat worker or closes one early. Neither touches reused, pre-existing,
setup, coordinator, active, or user-typed-in terminals. If a receipt says
`release_pending` or `release_unknown`, follow its recovery.

`orchestration reset` deletes coordination state; run it only when the user
gives that state up.
