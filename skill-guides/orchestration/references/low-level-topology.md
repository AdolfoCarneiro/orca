# Low-level topology

Use this only when `worker-start` cannot express the argv or terminal layout
you need (model and effort are not custom argv).

```text
ORCA terminal create --worktree active --title <task_name> --command "<agent_command>" --json
ORCA terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
ORCA orchestration dispatch --task <task_id> --to <handle> --inject --json
```

Wait for `tui-idle` only when startup could drop injected input.

`dispatch --inject` records the Task and Dispatch but does not supervise the
process: worker commands report it `unsupervised`, `worker-stop` and
`worker-abandon` leave it running, and release does not close it. To own an
existing agent terminal, use `worker-start --terminal <handle>` instead. Never
use low-level dispatch to get around the nesting cap or to hand work off.
