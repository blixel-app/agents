# Codex

The Blixel plugin's hooks queue each handoff into this thread with `codex queue`, as
a message that runs as a turn of its own, after the current one. The user typing
`$blixel:connect`, `$blixel:status` or `$blixel:disconnect`, or `connect blixel`, as
a whole prompt gets the answer with no model turn; this file is for every other way
of asking.

## Running `blixel agent`

Codex's sandbox blocks Blixel's local socket unless its network is on. Request
escalated permissions for `blixel agent connect`, as the skill says. Do the same for
`blixel agent status` and `blixel agent disconnect` unless they already work where
you are. Each runs by the skill's full path, never as a bare `blixel`.

## Connect

`blixel agent connect` connects this Codex thread (`CODEX_THREAD_ID`). The plugin's
hooks see that command and start following the thread as it runs; loading a skill
starts nothing.

On failure, by `code`:

- `monitor_not_running`: the plugin's hooks are not following this thread. Codex
  skips hooks nobody trusted, and they stop waiting after 2 minutes on an approval.
  Don't run it again: ask the user to update the Blixel plugin, run `/hooks`, trust
  its hooks, and type `$blixel:connect`.
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
ends the connection, except on Codex's shared app-server, where the thread keeps
running: disconnect first. A new conversation in the same
session (`/new`, `/resume`) is another thread and does not receive handoffs:
`$blixel:status` says so, and connecting from it moves them.
