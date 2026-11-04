# Codex

`blixel` here always means
`/Applications/Blixel.app/Contents/Resources/bin/blixel`, by that full path, or that path
under `~/Applications` if Blixel is there: never a bare `blixel`. Codex sets
`CODEX_THREAD_ID` for the commands it runs, which names this thread.

## Running `blixel agent`

Codex's sandbox blocks Blixel's local socket unless its network is on, so run every
`blixel agent` command outside it, each under its own prefix rule, so one saved
approval covers every later run:

- `connect` with `sandbox_permissions: "require_escalated"`, the justification
  "Connect this thread to the Blixel app on this Mac", and
  `prefix_rule: ["/Applications/Blixel.app/Contents/Resources/bin/blixel", "agent", "connect"]`.
- `status` and `disconnect` the same way, with `"status"` or `"disconnect"` in the rule,
  unless they already work where you are.

## Receiving

After `blixel agent connect` answers `"receiving": false`, start
`blixel agent receive --deliver-with <this skill's folder>/scripts/deliver/codex.sh`,
both by their full paths, with `exec_command`, `sandbox_permissions: "require_escalated"`,
`yield_time_ms` 2000, the justification "Receive Blixel handoffs in this thread", and
`prefix_rule: ["/Applications/Blixel.app/Contents/Resources/bin/blixel", "agent", "receive"]`.
It keeps running, and queues each handoff into this thread as a message that runs as
a turn of its own, after the current one. If it stops without an `ended` event, start
it again the same way.

After the user stops a turn with Esc, a handoff waits for their next message.

Unless this session was started with `--no-daemon`, tell the user it runs on Codex's
shared app-server, so this thread keeps receiving handoffs after they close the
terminal: ask this session to disconnect first.

## Connect failures

- `socket_blocked`, `agent_unverified`, or `app_unavailable` from a command that ran
  inside the sandbox: the sandbox stopped it, whatever the message says. Run it again
  outside the sandbox and approve it. If no escalation was offered, this session's
  permissions do not allow one: ask the user to run `/permissions` and choose
  Approve for me, then connect again. Don't change their settings unless they ask.

## Status and disconnect

A new conversation in the same session (`/new`, `/resume`) is another thread and
does not receive handoffs: connecting from it moves them.
