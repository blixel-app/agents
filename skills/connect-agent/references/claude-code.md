# Claude Code

The user can also type `/blixel:connect`, `/blixel:status` and
`/blixel:disconnect`.

`blixel` here always means
`/Applications/Blixel.app/Contents/Resources/bin/blixel`, by that full path, in a Monitor's
command too: a command run outside the sandbox and looked up on PATH runs whatever a
folder there holds. If that file doesn't exist, use
`~/Applications/Blixel.app/Contents/Resources/bin/blixel` the same way.

## How handoffs arrive

With the Blixel mod they come as prompts of their own, worded as the user set in
Blixel. Elsewhere they come as notifications from the Blixel plugin's "Blixel
handoffs" monitor, or from a "Blixel handoffs" Monitor this session started, one
line each.

## Monitor restart

A "Blixel handoffs" Monitor this session started stops after 30 minutes. When it
does, at once start the Monitor tool again with command `blixel agent follow`,
description `Blixel handoffs` and `timeout_ms` 1800000, then run
`blixel agent status`:

- `data.session.connection_id` set: run
  `blixel agent connect --meeting-id <data.meeting_id>`; it answers once the new
  Monitor has taken the connection over.
- Otherwise, if `data.session.ended.end_reason` is `monitor_stopped`, run
  `blixel agent connect --meeting-id <data.session.ended.meeting_id>`.
- Otherwise the connection was ended on purpose: stop that Monitor and don't
  connect again.

Tell the user only if connecting fails.

## Connect failures

- `monitor_not_running`: nothing in this session follows Blixel's handoffs: the
  plugin's monitor does not run here, as in the Claude desktop app, or it stopped.
  Start the Monitor tool with command `blixel agent follow`, description
  `Blixel handoffs` and `timeout_ms` 1800000, then run `blixel agent connect`
  again. If the Monitor tool is not available here, tell the user handoffs cannot
  reach this session because it cannot run a monitor; see
  https://blixel.app/docs/agents/troubleshooting.
- `socket_blocked`: Claude Code's sandbox blocks Blixel's socket. Ask the user to
  add `error.context.path` to `sandbox.network.allowUnixSockets` in their Claude
  Code settings, then connect again. Don't change their settings unless they ask.

## Status

`data.session.follower_attached` says whether this session's monitor is running:
the Blixel mod's, the plugin's or a "Blixel handoffs" Monitor.

## Disconnect

After disconnecting, stop any "Blixel handoffs" Monitor this session started.

Moving this session to the background stops its monitor and ends the connection
too; once attached again, connect again.
