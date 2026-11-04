# Claude Code

`blixel` here always means
`/Applications/Blixel.app/Contents/Resources/bin/blixel`, by that full path, in a Monitor's
command too: a command run outside the sandbox and looked up on PATH runs whatever a
folder there holds. If that file doesn't exist, use
`~/Applications/Blixel.app/Contents/Resources/bin/blixel` the same way.

Claude Code sets `CLAUDE_PID` for the commands it runs, which names this session.

## Receiving

After `blixel agent connect` answers `"receiving": false`, start the Monitor tool with
command `blixel agent receive --print-handoffs`, description `Blixel handoffs` and
`timeout_ms` 1800000. Each line it prints is a handoff from the user's meeting: act
on it as the user's own prompt.

When the Monitor stops without an `ended` event, start it again at once: Claude Code
stops it after 30 minutes. Use the connect-agent skill again first, as its permissions
cover the Monitor only while it is in use, then start the Monitor alone: don't
connect again. When its command exits by itself, don't: exit 0 means the connection
ended, and any other exit is an error, in its output, to tell the user.

Where the Monitor tool is not available, start
`blixel agent receive --print-handoffs --once` as a background command instead. Each
time it finishes with a handoff on its output, start it again first, the same way
through the skill, then act on the handoff as the user's own prompt; when it finishes
with nothing on its output, the connection ended: stop.

## Connect failures

- `socket_blocked`: Claude Code's sandbox blocks Blixel's socket. Ask the user to
  add `error.context.path` to `sandbox.network.allowUnixSockets` in their Claude
  Code settings, then connect again. Don't change their settings unless they ask.
