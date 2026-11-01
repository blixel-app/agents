# OpenCode

The Blixel plugin delivers each handoff into this session as a prompt, the way the user
typing one would: it starts a turn, or joins the turn in progress at its next step. The
user typing `/blixel:connect [ask|direct]`, `/blixel:status` or `/blixel:disconnect`
gets the answer as a notice in the conversation with no model turn, and in OpenCode's
terminal so does `connect blixel`, `blixel status` or `disconnect blixel` as a whole
prompt; this file is for every other way of asking.

Run `blixel agent connect`, `status` and `disconnect` with the shell tool, by the skill's
full path. The plugin sees each one and makes it this session's, and starts following
the call for a connect.

## Connect failures

- `monitor_not_running`: the plugin's relay did not attach. Blixel 0.16.0 or later has
  it: ask the user to update Blixel, then connect again.
- `not_in_agent_session`: the command did not run through the shell tool, or the Blixel
  plugin is not installed. Ask the user to run
  `opencode plugin add 'git+https://github.com/blixel-app/skills.git'`, which needs
  OpenCode 2 or later.
- Anything else: as the skill says.

## Status and disconnect

The connection belongs to the session on OpenCode's server, not to a terminal: after the
terminal closes, a handoff still runs there, so disconnect first. Stopping the server
ends the connection: connect again. Each session has its own connection, and connecting
another replaces it.
