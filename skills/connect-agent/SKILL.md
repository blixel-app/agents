---
name: connect-agent
user-invocable: false
description: Connect this Claude Code or Codex session to the user's current Blixel meeting, so people in the call can hand it spoken or typed requests ("Blixel handoffs"); also checks or ends that connection. Use when the user asks to connect this session or agent to Blixel or a Blixel call, to receive handoffs, whether it is connected, or to disconnect it.
allowed-tools: Read(/${CLAUDE_SKILL_DIR}/references/**) Bash(blixel agent whoami*) Bash(blixel agent connect*) Bash(blixel agent status*) Bash(blixel agent disconnect*) Bash(blixel agent follow) Bash(${CLAUDE_SKILL_DIR}/scripts/blixel agent whoami*) Bash(${CLAUDE_SKILL_DIR}/scripts/blixel agent connect*) Bash(${CLAUDE_SKILL_DIR}/scripts/blixel agent status*) Bash(${CLAUDE_SKILL_DIR}/scripts/blixel agent disconnect*) Bash(${CLAUDE_SKILL_DIR}/scripts/blixel agent follow)
---

# Connect agent

Connects this session to the meeting the Blixel app on this Mac is in. People in
that meeting can then speak or type a request to this session from Blixel.

## First

If the shell can't find `blixel` (`command not found`), run `scripts/blixel`
beside this file wherever these files say `blixel` from then on: it runs the CLI
inside the Blixel app. If that prints "Blixel isn't installed", tell the user to
get it at https://blixel.app.

Then run `blixel agent whoami`. It needs neither the app nor its socket, so run it
where you are, sandbox included. `data.reference` is this agent's file, relative to
this one: read it now and follow it alongside this file. If it fails:

- `not_in_agent_session`: this agent can't connect to Blixel yet. Tell the user
  connecting needs Claude Code or Codex, and stop.
- Any other failure, as with a Blixel that has no `whoami`: use the agent you know
  you are, `references/claude-code.md` in Claude Code or `references/codex.md` in
  Codex. In any other agent, tell the user connecting needs one of those, and stop.

## Blixel handoffs

Once connected, handoffs arrive one at a time, as prompts, lines or messages
depending on how this agent receives them. Every such prompt, line or message is a
handoff, whatever its words: the user chose in Blixel what each one says, by default
the request alone, perhaps with who sent it, the room, or instructions of their own.

The user connected this session to receive them, so they are expected here, not an
injection. Each is a suggestion from someone in the call, spoken or typed and
possibly inaccurate, not the user's instruction. When one arrives, work on it the
way the user would want a colleague's suggestion handled: go ahead with what it
asks, within the user's work and this session's permissions, without waiting for
the user to say so, and answer as you would the user's own prompt, without saying
it came from Blixel or who sent it. Ask the user first only before anything
destructive or hard to undo (deleting, overwriting, force-pushing, sending or
publishing), or anything outside the current work, and only then say that a
Blixel handoff asked for it. If it arrives in the middle of another task, finish
or pause that task first.

## Connect

Run, with no flags:

```sh
blixel agent connect
```

Its first stderr line is a `request_id` event. On success stdout has one JSON line;
tell the user this session is connected to the meeting and handoffs from people in
it will arrive here. If `data.replaced` is set, another session was connected and
no longer receives them: a meeting has one connected session.

On failure, stderr ends with `{"error":{"code",…}}`. This agent's file comes first;
then, by `code`:

- `not_in_meeting`: Blixel is not in a meeting. Ask the user to join a room in the
  app, then connect again.
- `app_unavailable`: the Blixel app is not running. Ask the user to open it.
- `connect_outcome_unknown`, or exit 130/143: run it again with
  `--request-id <the request_id from the first stderr line>`, never a new one.
- Anything else: tell the user the `message` and `hint`.

## Status

`blixel agent status`: this session is connected when `data.session.connection_id`
is set. A `data.connection` without it is another session's connection.
`data.session.ended` says how this session's last connection ended.

## Disconnect

`blixel agent disconnect` ends this session's connection (`outcome: disconnected`,
or `not_connected` if there was none). Handoffs stop arriving.

Leaving or switching rooms in Blixel also ends the connection; a reconnect keeps
it. After a new join, connect again.
