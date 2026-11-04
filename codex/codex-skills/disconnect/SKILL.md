---
name: disconnect
description: Stop receiving Blixel handoffs in this session.
---

The plugin's hooks run `$blixel:disconnect` themselves. If a note from the Blixel
plugin's hook in this turn gives its answer, tell the user that answer in one short line
and run nothing.

With no such note, its hooks are not trusted or the prompt held other words. Follow the
blixel:connect-agent skill's Disconnect section, by the full path it gives.
