# Low-level topology

```text
ORCA terminal create --worktree active --title <task_name> --command "<agent_command>" --json
ORCA terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
ORCA orchestration dispatch --task <task_id> --to <handle> --inject --json
```

If a `terminal send` submit is unconfirmed, rerun the same send with its
receipt's `--retry-request <id>` and `--wait-submit <seconds>`; that never sends
twice.
