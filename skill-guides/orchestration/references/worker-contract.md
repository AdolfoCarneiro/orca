# Worker contract

Your preamble is authoritative: copy its commands exactly, including any extra
flag.

## Ask

Ask through Orca, never a local prompt the coordinator cannot see:

```text
ORCA orchestration ask --from <worker_handle> --question "<question>" --options "<choice-a>,<choice-b>" --timeout-ms 600000
ORCA orchestration ask --from <worker_handle> --resume <message_id> --timeout-ms 600000
```

A wait lasts up to `--timeout-ms` (default 10 minutes, at most 30). On a
timeout or disconnect the question stays pending: resume it by message ID; do
not ask again.

## Coordinator mail

Nothing interrupts you; mail arrives only when you check. Check at natural
checkpoints and once right before `worker_done`:

```text
ORCA orchestration check --terminal <worker_handle> --json
```

Repeat until `count` is 0. For a lost reply or lost context, and for older
Orca, see `references/messaging-and-gates.md`.

Never `run-use` the Run your Dispatch is in, or any parent Run. If a plain
`check` returns `consumer_fenced`, you no longer own this Dispatch: stop, and
send no `worker_done`. If `send` or `ask` returns it, you ran it from a terminal that is
not yours.

## Helpers

Start helpers only as the preamble's SUB-DISPATCH section says. Their mail
arrives in your `check`; answer with `reply`. Wait for every helper to settle
before your `worker_done`, and name any that failed.

## Escalate

Only before you finish, and only when the coordinator must act:

```text
ORCA orchestration send --from <worker_handle> --type escalation --subject "Blocked: <reason>" --body "<details>" --task-id <task_id> --dispatch-id <dispatch_id>
```

## Finish

Send one `worker_done`. The body is three sentences: what changed, what you
found, what remains. Use `--outcome failed` when the work is not done; never
hide failure in prose. Add `--files-modified` or `--report-path` only with real
paths.

```text
ORCA orchestration send --from <worker_handle> --type worker_done --subject "<short status>" --body "<work, findings, remaining>" --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded
```

Then end your turn; do not poll or start other work. A later direct user
request is new work: do it without the settled IDs.
