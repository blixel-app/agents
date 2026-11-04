#!/bin/sh
# The pi and OpenCode plugins, run in-process against fakes of each agent's plugin API
# and a stand-in `blixel`, under Node's own test runner: `claude plugin test` loads no
# `node:` module.
exec node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-timeout=60000 "$(dirname "$0")"/*.spec.ts
