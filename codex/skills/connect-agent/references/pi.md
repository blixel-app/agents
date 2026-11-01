# pi

The Blixel package's extension delivers each handoff into this session as a prompt,
which runs as a turn of its own, after any turn in progress. Only the user can connect,
with no model turn: `/blixel:connect [ask|direct]`, `/blixel:status` and
`/blixel:disconnect`, or `connect blixel`, `blixel status` and `disconnect blixel` as a
whole prompt.

Don't run `blixel agent` here: Blixel can't tell a command you run belongs to this
session, so it fails with `not_in_agent_session`. When asked to connect, check or
disconnect, ask the user to type the command.

## After a failed connect

The extension shows the user the `message` and `hint`. If they ask what to do:

- `monitor_not_running`: the extension's relay did not attach. Blixel 0.16.0 or later
  has it: ask them to update Blixel and type `/blixel:connect`.
- Anything else: as the skill says, with the user typing the command in place of
  running it.

## Status and disconnect

Quitting pi and starting a new session (`/new`, `/resume`, `/fork`) both end the
connection: connect the new session again. A killed pi ends it too.
