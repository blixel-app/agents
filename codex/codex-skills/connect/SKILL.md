---
name: connect
description: Connect this session to the Blixel meeting, so people in it can hand it requests. Add ask or direct to choose whether Blixel asks before each handoff.
---

The plugin's hooks answer `$blixel:connect` on its own, with no model. This prompt
reached you, so they did not: nobody trusted them, or the prompt held other words.

Run `/Applications/Blixel.app/Contents/Resources/bin/blixel agent connect` as
`references/codex.md` of the blixel:connect-agent skill says, adding `--approval ask` or `--approval direct` if the
prompt names one. If it fails with
`monitor_not_running`, don't run it again: tell the user to run `/hooks`, trust
Blixel's hooks, and type `$blixel:connect`.
