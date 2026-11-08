# OpenCode

`blixel` here always means
`/Applications/Blixel.app/Contents/Resources/bin/blixel`, by that full path, or that path
under `~/Applications` if Blixel is there. Run every `blixel agent` command with the
shell tool: OpenCode sets `OPENCODE_SESSION_ID` there, which names this session.

## Receiving

After `blixel agent connect` answers `"receiving": false`, start
`blixel agent receive --deliver-with <this skill's folder>/scripts/deliver/opencode.sh`,
both by their full paths, with the shell tool and `background: true`. It keeps
running, and prompts each handoff into this session through OpenCode's server, the
way the user typing it would.

OpenCode resumes you when it ends: after an `ended` event, do nothing; otherwise
start it again.

A session started with `opencode --standalone` has no server to prompt: it needs the
Blixel plugin, `opencode plugin add 'git+https://github.com/blixel-app/agents.git'`.

## Status and disconnect

The connection belongs to the session on OpenCode's server, not to a terminal: after
the terminal closes, a handoff still runs there, so disconnect first. Stopping the
server ends the receiving: connect again.
