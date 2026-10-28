# Coordinator loop

Load this reference for expanded DAG waves, per-invocation launch preferences,
same-terminal reuse, or review ownership. The main guide remains the source of
truth for the loop order and when you are done.

## Ready waves

Create independent Tasks before you end your first turn. Encode only real
dependencies, prefer parallel waves over chains deeper than three or four steps,
and use the ready view as external memory. Start a planned Task with `--task`,
choosing placement as the main guide describes; workers editing the same files
in parallel need separate workspaces. A retry also needs `--retry-of` (see
`references/recovery-and-cleanup.md`):

```text
ORCA orchestration task-create --spec "<dependent work>" --deps <json_array> --json
ORCA orchestration task-list --ready --brief --json
ORCA orchestration worker-start --task <task_id> --worktree current --agent codex --json
```

For a new worktree, use the placement recipe in the main guide, including
`--name`.

`--brief` collapses whitespace and caps echoed specs at 160 characters;
`spec_truncated` identifies shortened rows. Omit it when full specs are needed or
when an older CLI rejects the flag. A nested worker must respect
`nested_worker_depth_exceeded`; creating another Run does not reset depth.
Helpers a worker starts appear in this Run's `worker-list` with their
`creatorDispatchId`, and report to that worker rather than to you.

## Launch preferences

For a fresh Claude, Codex, Cursor, Antigravity, or Muse terminal, `--model`
accepts an opaque provider model ID. Pass it only when the user named a model;
otherwise omit it so the worker inherits the user's configured agent default.
Add `--effort` only when that model supports it:

```text
ORCA orchestration worker-start --task <task_id> --worktree current --agent claude --model opus --effort high --json
ORCA orchestration worker-start --task <task_id> --worktree current --agent muse --model muse-spark-1.3 --json
```

OpenCode also accepts `--model` in an existing worktree when the execution host
verifies its CLI version and model availability. Creating a new worktree with an
OpenCode model override is unsupported; use `--worktree current` or an existing
worktree selector, or omit `--model`. OpenCode effort is unsupported. Omit the
model to inherit its configuration; unsupported or unknown hosts refuse the
override explicitly.

`--effort` requires `--model`; neither option combines with `--terminal`. A
connected worker server must advertise launch-preference support before Orca
forwards either field. Compare `launch.requested` with `launch.effective`; never
claim a model or effort from requested arguments alone.

## Reuse after settlement

Choose the terminal's next owner before the next `check`. A terminal worker is
released about 2 minutes after `worker_done`; to reuse it later than that, run
`worker-retain` first. When the same exact agent has immediate follow-up work,
recover the proven handle and transfer cleanup ownership to the new Dispatch:

```text
ORCA orchestration worker-show --dispatch <dispatch_id> --json
ORCA orchestration worker-start --task <next_task_id> --terminal <agent_terminal_handle> --json
```

Otherwise let the automatic release run, or release it explicitly; a chat worker
always needs `worker-release`. Do not retain it only to read output; archived
output remains available through `worker-read`.

## Review ownership

A review-only `worker_done` authorizes synthesis of findings, not coordinator
file edits. Dispatch or hand off fixes unless the user explicitly assigned them
to the coordinator. If the user's plan names a next owner, post-review fixes and
PR preparation remain with that owner; the coordinator routes and synthesizes.
