# Built-in browser commands

Pin one page, then use a snapshot-interact-re-snapshot loop on it:

```text
ORCA tab current --json
ORCA goto --page <browserPageId> --url https://example.com --json
ORCA snapshot --page <browserPageId> --json
ORCA click --page <browserPageId> --element @e3 --json
ORCA snapshot --page <browserPageId> --json
```

Common commands:

```text
ORCA goto --page <browserPageId> --url <url> --json
ORCA back --page <browserPageId> --json
ORCA reload --page <browserPageId> --json
ORCA snapshot --page <browserPageId> --json
ORCA screenshot --page <browserPageId> --json
ORCA full-screenshot --page <browserPageId> --json
ORCA pdf --page <browserPageId> --json
ORCA click --page <browserPageId> --element <ref> --json
ORCA fill --page <browserPageId> --element <ref> --value <text> --json
ORCA type --page <browserPageId> --input <text> --json
ORCA select --page <browserPageId> --element <ref> --value <value> --json
ORCA check --page <browserPageId> --element <ref> --json
ORCA scroll --page <browserPageId> --direction down --amount 1000 --json
ORCA hover --page <browserPageId> --element <ref> --json
ORCA focus --page <browserPageId> --element <ref> --json
ORCA keypress --page <browserPageId> --key Enter --json
ORCA upload --page <browserPageId> --element <ref> --files <paths> --json
ORCA wait --page <browserPageId> --text <text> --json
ORCA wait --page <browserPageId> --url <substring> --json
ORCA wait --page <browserPageId> --selector <css> --json
ORCA wait --page <browserPageId> --load networkidle --json
ORCA eval --page <browserPageId> --expression <js> --json
ORCA set device --page <browserPageId> --name "iPhone 15" --json
ORCA viewport --page <browserPageId> --width 390 --height 844 --scale 3 --mobile --json
ORCA tab list --json
ORCA tab create --url <url> --json
ORCA tab switch --index <n> --json
ORCA tab close --index <n> --json
ORCA cookie get --page <browserPageId> --json
ORCA capture start --page <browserPageId> --json
ORCA console --page <browserPageId> --limit 50 --json
ORCA network --page <browserPageId> --limit 50 --json
ORCA exec --page <browserPageId> --command "help" --json
```

Browser rules:

- Re-snapshot after navigation, tab switches, clicks that change the page, and any `browser_stale_ref`.
- Refs like `@e1` are assigned by `snapshot`, scoped to one tab, and invalidated by navigation or tab switch.
- Always pass `--page <browserPageId>`. Take it from `tab.browserPageId` in `ORCA tab current --json` (the tab the user has open) or `browserPageId` in `ORCA tab create --json`, then reuse it on every command. Without `--page`, a command goes to the worktree's current tab, which moves to the tab the user picked once yours has had no command for about 20 seconds.
- After `ORCA tab switch`, pass the new page's `browserPageId`.
- Browser commands default to the current worktree. Use `--worktree all` only intentionally.
- Use typed tab commands (`ORCA tab list/create/close/switch`), not `ORCA exec --command "tab ..."`, so Orca keeps UI state synchronized.
- Use `ORCA set device` or `ORCA viewport --mobile`, not `ORCA exec --command "set device ..."`, so the page also gets touch input and `pointer: coarse`. Each page load (reload, `goto`, link click) resets it, so run it again after navigating.
- Prefer `wait --text`, `--url`, `--selector`, or `--load` after async page changes instead of bare timeouts.
- Anything not listed above goes through `ORCA exec --command "<agent-browser command>"`.
- If `fill` or `type` fails on a custom input, try `ORCA focus --element @e1 --json` then `ORCA inserttext --text "text" --json`.
- A client-hosted page renders in the paired desktop's browser engine, so every command against it needs that desktop online and returns `browser_host_unavailable` while it is closed, asleep, or disconnected. Server-hosted pages run with no desktop attached; prefer them for long or unattended automation.

Common recoveries:

- `browser_no_tab`: open a tab with `ORCA tab create --url <url> --json`.
- `browser_stale_ref`: run `ORCA snapshot --json` and retry with fresh refs.
- `browser_tab_not_found`: run `ORCA tab list --json` before switching or closing.
- `browser_host_unavailable`: the desktop hosting the page is offline. Bring it back, or recreate the page with server placement if the work must outlive the desktop session.
