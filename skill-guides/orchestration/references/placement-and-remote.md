# Placement and remote execution

```text
# Child of the current worktree.
ORCA orchestration worker-start --task <task_id> --worktree new-child --name <name> --agent codex --setup run --json

# On a connected server; the Run stays on yours.
ORCA orchestration worker-start --task <task_id> --on <environment> --worktree new-top-level --repo <exact_remote_repo_selector> --name <name> --agent codex --setup run --json
```

After start, address a remote worker only by Dispatch ID, never by a terminal
handle.
