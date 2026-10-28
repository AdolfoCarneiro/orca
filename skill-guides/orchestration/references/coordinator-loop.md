# Coordinator loop

## Task DAGs

Create every Task before your first turn ends. Add `--deps` only for real
dependencies; prefer parallel waves to long chains. Workers editing the same
files at once need separate workspaces.

```text
ORCA orchestration run-create --objective "<goal>" --json
ORCA orchestration task-create --spec "<dependent work>" --deps <json_array> --json
ORCA orchestration task-list --ready --brief --json
ORCA orchestration worker-start --task <task_id> --worktree current --agent codex --json
```

`--brief` shortens long specs (`spec_truncated` marks them); omit it when you
need the full text. Pass `json_array` with the quoting rules of your shell.

## Several Runs

`worker-start --spec` creates a Run when you have none. A later `run-create`
starts another Run and keeps the earlier ones: their mail still wakes you with
`check --run <id>`, but commands without `--run` use the newest Run, so pass
`--run <id>` when acting on an earlier one.
`run-use` keeps only the Run it names.

## Helpers and nesting

Helpers a worker starts report to that worker, not you, and show in your
`worker-list` with `creatorDispatchId`. Nesting is capped
(`nested_worker_depth_exceeded`); a new Run does not reset it.

## Model and effort

Pass `--model` only when the user named a model; otherwise the worker uses its
default. Add `--effort` only with `--model`, and only if that model
supports it. Neither works with `--terminal`.

```text
ORCA orchestration worker-start --task <task_id> --worktree current --agent claude --model opus --effort high --json
```

OpenCode takes `--model` only in an existing workspace, never `--effort`.
Report the receipt's `launch.effective`, not your request.

## Reusing a worker

Finished terminal workers close about 2 minutes after `worker_done`. To give
the same agent follow-up work, start the next Task on its terminal (this also
stops the close):

```text
ORCA orchestration worker-show --dispatch <dispatch_id> --json
ORCA orchestration worker-start --task <next_task_id> --terminal <agent_terminal_handle> --worktree <its_workspace> --json
```

Run `worker-retain` only to keep one open with no follow-up yet;
`worker-read` reads saved output.
