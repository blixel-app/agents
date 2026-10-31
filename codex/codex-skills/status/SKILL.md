---
name: status
description: Show whether this session receives Blixel handoffs.
---

The plugin's hooks answer `$blixel:status` on its own, with no model. This prompt
reached you, so they did not. Follow the blixel:connect-agent skill's Status section,
and tell the user what it says. If its hooks are not trusted, tell the user they need
`/hooks`, as no handoff arrives without them.
