# Placement and remote execution

## Placement

A new worker is a new agent terminal, not a new worktree. Use the current or an
existing workspace unless the user asked for a new one or sharing would
conflict.

```text
# Current workspace; setup does not rerun.
ORCA orchestration worker-start --task <task_id> --worktree current --agent codex --json

# Child of the current worktree.
ORCA orchestration worker-start --task <task_id> --worktree new-child --name <name> --agent codex --setup run --json

# New top-level worktree; --repo is needed outside that project.
ORCA orchestration worker-start --task <task_id> --worktree new-top-level --repo id:<repoId> --name <name> --agent codex --setup run --json
```

`new-child`, and `new-top-level` without `--repo`, need you inside an Orca
worktree. New worktrees run setup and follow the repository's startup policy.
For an existing worktree, pass the full ID Orca returned as
`id:<repo-id>::<path>`; a repo ID is not a worktree ID.

## Folder workspaces

Folders are first-class: never run Git or require a worktree for one. `repo add`
rejects a plain folder; register it with:

```text
ORCA project setup-existing-folder --project <project_id> --host <host_id> --path <abs_path> --kind folder --json
```

Then place work there with its exact selector. `new-child` and `new-top-level`
do not apply to folders.

## Connected servers

The Run stays on your server; `--on` picks only where the worker runs:

```text
ORCA orchestration worker-start --task <task_id> --on <environment> --worktree new-top-level --repo <exact_remote_repo_selector> --name <name> --agent codex --setup run --json
```

`current` and `new-child` are invalid with `--on`; use an exact remote
workspace or `new-top-level` with an exact remote repo. After start, do
everything by Dispatch ID (`send --to dispatch:<id>`, `worker-show`,
`worker-read`, `worker-stop`); never repeat `--on` or use a remote terminal
handle. List remote workers with `worker-list --run <run_id> --include-remote`.

The execution host owns process, file, and cleanup facts; lost contact reads
`unverifiable`, never `exited`. Servers update separately, so optional fields
may be missing.

For WSL, run the exact executable Orca prints (such as `orca-ide`).
