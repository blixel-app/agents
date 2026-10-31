# Codex

Blixel queues each handoff into this thread with `codex queue`, as a message that
runs as a turn of its own, after the current one.

## Running `blixel agent`

`blixel agent connect` must run outside Codex's sandbox: Blixel refuses a connect
from inside it. Request escalated permissions for that one command, saying it
connects to the Blixel app on this Mac. Do the same for `blixel agent status` and
`blixel agent disconnect` unless they already work where you are: Codex's sandbox
blocks Blixel's local socket unless its network is on. `blixel agent whoami` works
inside it.

## Connect

`blixel agent connect` connects this Codex thread (`CODEX_THREAD_ID`). Report
success and `data.replaced` as the skill says. If `data.codex_shared_app_server` is
true, also tell the user that this thread runs on Codex's shared app-server, so a
handoff still runs in it after they close this terminal: ask this session to
disconnect first.

On failure, by `code`:

- `socket_blocked`, `agent_unverified`, or `app_unavailable` from a command that ran
  inside the sandbox: the sandbox stopped it, whatever the message says. A sandboxed
  command can read `app_unavailable` with the app open, and a sandboxed connect
  reads "This command does not run inside the Codex session CODEX_THREAD_ID names".
  Run it again outside the sandbox. If no escalation was offered, this session's
  permissions do not allow one: ask the user to run `/permissions` and choose
  Approve for me, then connect again. Don't change their settings unless they ask.
- Any other code: as the skill says.

## Status and disconnect

This thread is connected when `data.session.connection_id` is set. Quitting Codex
ends the connection, except on the shared app-server (`codex_shared_app_server`),
where the thread keeps running: disconnect first. A new conversation in the same
session (`/new`, `/resume`) is another thread and does not receive handoffs: connect
again from it.
