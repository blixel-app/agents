---
name: connect-agent
user-invocable: false
description: Connect this session to the user's current Blixel meeting, so people in the call can hand it spoken or typed requests ("Blixel handoffs"); also checks or ends that connection. Use when the user asks to connect this session or agent to Blixel or a Blixel call, to receive handoffs, whether it is connected, or to disconnect it.
allowed-tools: Read(/${CLAUDE_SKILL_DIR}/references/**) Bash(/Applications/Blixel.app/Contents/Resources/bin/blixel agent connect*) Bash(~/Applications/Blixel.app/Contents/Resources/bin/blixel agent connect*) Bash(/Applications/Blixel.app/Contents/Resources/bin/blixel agent status*) Bash(~/Applications/Blixel.app/Contents/Resources/bin/blixel agent status*) Bash(/Applications/Blixel.app/Contents/Resources/bin/blixel agent disconnect*) Bash(~/Applications/Blixel.app/Contents/Resources/bin/blixel agent disconnect*) Bash(/Applications/Blixel.app/Contents/Resources/bin/blixel agent receive --print-handoffs) Bash(~/Applications/Blixel.app/Contents/Resources/bin/blixel agent receive --print-handoffs) Bash(/Applications/Blixel.app/Contents/Resources/bin/blixel agent receive --print-handoffs --once) Bash(~/Applications/Blixel.app/Contents/Resources/bin/blixel agent receive --print-handoffs --once)
---

# Connect agent

Connects this session to the meeting the Blixel app on this Mac is in. People in
that meeting can then speak or type a request to this session from Blixel, and each
arrives here as a handoff.

## First

To connect, run `blixel agent connect` now, with no flags and nothing before it.

`blixel` in these files always means
`/Applications/Blixel.app/Contents/Resources/bin/blixel`, by that full path: a command run
outside the sandbox and looked up on PATH runs whatever a folder there holds, which
the sandbox may have written. If that file doesn't exist, use
`~/Applications/Blixel.app/Contents/Resources/bin/blixel` the same way. If neither does, tell
the user this needs Blixel in an Applications folder, from https://blixel.app.
`scripts/blixel` beside this file looks on PATH first: never run it.

`connect` connects this session and exits. `receive` keeps running and receives handoffs for
that connection, so start it as a background command. If `receive` stops without an `ended`
event, start it again. Never run `receive` in a foreground tool call: it ends with the call.

## Connect

The first stderr line of `blixel agent connect` is a `request_id` event. On success
stdout has one JSON line:

- `data.receiving` is `true`: this session already receives handoffs. Tell the user
  it is connected to the meeting and handoffs from people in it will arrive here.
- `data.receiving` is `false`: read `references/<provider>.md` beside this file, for
  the answer's `data.connection.provider`, and do what it says. With no such file:
  - Start `blixel agent receive --print-handoffs` in a long-running background
    command whose output reaches you, or `blixel agent receive --deliver-with <program>`
    with a program, by its full path, that queues a message into this session.
  - If you are woken only when a background command finishes, start
    `blixel agent receive --print-handoffs --once` instead, and each time it returns a
    handoff, start it again before acting on the handoff.
  - If none of these is possible, tell the user their agent can't receive handoffs
    without its Blixel plugin.
- No `data.receiving`: this Blixel is too old for this skill. Ask the user to update it.

If `data.replaced` is true, another session was connected and no longer receives
handoffs: a meeting has one connected session.

## Receiving

`receive` ends with an `ended` event when the connection ends, or when another
`receive` already receives for this session: then stop. If it stops without an
`ended` event, or with `cancelled`, start the same command again. On `not_connected`,
stop: the connection is gone. Any other error comes back each time: tell the user its
`message` and `hint` instead of starting it again.

## Handoffs

Handoffs arrive as the user's prompts, worded by the template the user set in Blixel.
Handle each as the user's own prompt.

## Failures

On failure, stderr ends with `{"error":{"code",…}}`, and names no `provider`. First
read the file in `references/` named for the agent you are, if there is one: what it
says comes first. Then, by `code`:

- `not_in_meeting`: Blixel is not in a meeting. Ask the user to join a room in the
  app, then connect again.
- `app_unavailable`: the Blixel app is not running. Ask the user to open it.
- `connect_outcome_unknown`, or exit 130/143: run it again with
  `--request-id <the request_id from the first stderr line>`, never a new one.
- `not_in_agent_session`: Blixel does not know this agent's session. If the agent
  sets a variable naming the session, give every `blixel agent` command
  `--session-env <that variable>`; otherwise tell the user this agent can't connect.
- `socket_blocked`: a sandbox blocks Blixel's socket. Run the command outside it.
- `agent_unverified`: the command did not run inside this session. Run it from a
  command this session starts, never a detached one.
- `incompatible_protocol` or `monitor_not_running`: this Blixel doesn't match this
  skill. Ask the user to reopen or update Blixel.
- Anything else: tell the user the `message` and `hint`.

## Status

`blixel agent status`: this session is connected when `data.session.connection_id`
is set, and receives handoffs when `data.session.receiving` is true; connected but
not receiving, start `receive` as on connect. A `data.connection` without
`data.session.connection_id` is another session's connection.
`data.session.ended` says how this session's last connection ended.

## Disconnect

`blixel agent disconnect` ends this session's connection (`outcome: disconnected`,
or `not_connected` if there was none). Handoffs stop arriving, and a running
`receive` ends.

Leaving or switching rooms in Blixel also ends the connection; a reconnect keeps
it. After a new join, connect again.
