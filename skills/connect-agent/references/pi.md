# pi

The Blixel package's extension delivers each handoff into this session as a prompt,
which runs as a turn of its own, after any turn in progress. The user typing
`/blixel:connect [ask|direct]`, `/blixel:status` or `/blixel:disconnect`, or
`connect blixel`, `blixel status` or `disconnect blixel`, as a whole prompt gets the
answer with no model turn; this file is for every other way of asking.

Run `blixel agent connect`, `status` and `disconnect` with the bash tool, by the skill's
full path. The extension sees each one and makes it this session's, and starts following
the call for a connect.

## Connect failures

- `monitor_not_running`: the extension's relay did not attach. Blixel 0.16.0 or later has
  it: ask the user to update Blixel, then connect again.
- `not_in_agent_session`: the command did not run through the bash tool, or the Blixel
  extension is not installed. Ask the user to run `pi install git:github.com/blixel-app/skills`.
- Anything else: as the skill says.

## Status and disconnect

Quitting pi and starting a new session (`/new`, `/resume`, `/fork`) both end the
connection: connect the new session again. A killed pi ends it too.
