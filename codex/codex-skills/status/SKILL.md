---
name: status
description: Show whether this session receives Blixel handoffs.
---

The plugin's hooks run `$blixel:status` themselves. If a note from the Blixel plugin's
hook in this turn gives its answer, tell the user that answer in one short line and run
nothing.

With no such note, its hooks are not trusted or the prompt held other words. Follow the
blixel:connect-agent skill's Status section, by the full path it gives, and tell the
user what it says. If its hooks are not trusted, tell the user they need `/hooks`, as
no handoff arrives without them.
