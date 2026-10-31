---
description: Connect this session to the Blixel meeting, so people in it can hand it requests
argument-hint: "[ask|direct]"
disable-model-invocation: true
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/skills/connect-agent/scripts/connect.sh"*)
---

!`"${CLAUDE_PLUGIN_ROOT}/skills/connect-agent/scripts/connect.sh" $ARGUMENTS`

That is `blixel agent connect`, already run for this session, and how to handle its answer: report it as that text says, without running it again unless that text says to. If shell execution was disabled instead, connect this session with the blixel:connect-agent skill, and if "$ARGUMENTS" is `ask` or `direct`, pass it as `--approval`.
