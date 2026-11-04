---
name: connect
description: Connect this session to the Blixel meeting, so people in it can hand it requests.
---

The plugin's hooks run `$blixel:connect` themselves. If a note from the Blixel plugin's
hook in this turn gives its answer, tell the user that answer in one short line and run
nothing: the hook already connected, or found why it could not.

With no such note, its hooks are not trusted or the prompt held other words. Connect as
the blixel:connect-agent skill says, following its `references/codex.md`: run
`/Applications/Blixel.app/Contents/Resources/bin/blixel agent connect` outside the
sandbox, then start `receive` as that file says.
