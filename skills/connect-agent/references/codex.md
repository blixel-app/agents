# Codex

The Blixel plugin's hooks queue each handoff into this thread with `codex queue`, as
a message that runs as a turn of its own, after the current one. The user typing
`connect blixel` as a whole prompt connects with no model turn; this file is for
every other way of asking.

## Running `blixel agent`

Codex's sandbox blocks Blixel's local socket unless its network is on. Request
escalated permissions for `blixel agent connect`, as the skill says. Do the same for
`blixel agent status` and `blixel agent disconnect` unless they already work where
you are.

## Connect

`blixel agent connect` connects this Codex thread (`CODEX_THREAD_ID`) to the hooks
already following it.

On failure, by `code`:

- `monitor_not_running`: the plugin's hooks are not running in this session, which
  is what Codex does with hooks nobody trusted. Don't run it again yet: ask the user
  to update the Blixel plugin, run `/hooks` and trust its hooks, and send any
  message; then connect again.
- `socket_blocked`, `agent_unverified`, or `app_unavailable` from a command that ran
  inside the sandbox: the sandbox stopped it, whatever the message says. A sandboxed
  command can read `app_unavailable` with the app open, and an older Blixel's
  sandboxed connect reads "This command does not run inside the Codex session
  CODEX_THREAD_ID names". Run it again outside the sandbox. If no escalation was offered, this session's
  permissions do not allow one: ask the user to run `/permissions` and choose
  Approve for me, then connect again. Don't change their settings unless they ask.
- Any other code: as the skill says.

## Status and disconnect

This thread is connected when `data.session.connection_id` is set. Quitting Codex
ends the connection, except on the shared app-server (`codex_shared_app_server`),
where the thread keeps running: disconnect first. A new conversation in the same
session (`/new`, `/resume`) is another thread and does not receive handoffs, which
a hook tells the user at its start: connect again from it.
