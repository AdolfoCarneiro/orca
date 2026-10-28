# Legacy contract migration

Use this only for a legacy label, an adopted Run, a compatibility or recovery
receipt, or a legacy takeover. New work always uses the current commands.

## Labels

- `[LEGACY COMPATIBILITY]`: live. Run only the exact command printed with it,
  with the same executable.
- `[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]`: a one-time replay. Handle it
  so a repeat does no harm, and acknowledge only as it says.
- `[LEGACY READ-ONLY]`: look only; no reply, ack, or lifecycle change.
- No label: current rules.

A current Run, binding, or Dispatch wins over legacy fallback. An adoption
record alone grants nothing. If ownership or the exact legacy contract is
unproven, only inspect; never fall back to doing the work locally.

Adoption keeps the live worker, terminal, workspace, Task, and Dispatch; it
never restarts, replaces, or writes to them.

## Compatibility receipts

Run a receipt's next-step arguments exactly, with the same executable. If an
`ask` may already be answered, run the recovery `check` Orca printed before
asking again.

On packaged Windows a legacy `ask` commits the question, prints an exact
`ask --resume <message_id>` command, and exits with status `75`; run that
command after the update. For WSL, keep the printed `orca-ide` executable.

## Inspect and take over

These only read:

```text
ORCA orchestration run-list --json
ORCA orchestration run-show --id <adopted_run_id> --json
ORCA orchestration task-list --run <adopted_run_id> --json
ORCA orchestration check --terminal <legacy_handle> --peek --json
ORCA terminal read --terminal <legacy_handle> --json
```

`run_legacy_local` is an empty record after adoption; the work lives in the Run
whose objective is `Recovered orchestration work from a contract update`.

Only if the original coordinator is gone or cannot prove ownership, take over
from your own terminal:

```text
ORCA orchestration run-use --id <adopted_run_id> --takeover-legacy --json
ORCA orchestration check --run <adopted_run_id> --json
```

Takeover fences only the old coordinator and keeps every worker and file.
Never take over from an active coordinator, and never start a second editor
just because Orca updated.
