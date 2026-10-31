#!/bin/sh
# After /clear or a compaction the conversation no longer holds the skill's
# text, while the session's connection and monitor carry on: without it the
# model refuses handoffs as background notifications.
status=$("$(dirname "$0")/blixel" agent status 2>/dev/null) || exit 0
# Parsed, not matched: the session's other keys change between app versions,
# and its ended connection holds a connection_id of its own.
printf '%s' "$status" | plutil -extract data.session.connection_id raw -o - - >/dev/null 2>&1 || exit 0
echo "This Claude Code session is connected to the user's Blixel meeting: the user ran the Blixel connect-agent skill to receive handoffs before this conversation was cleared or compacted."
sed -n '/^## Blixel handoffs$/,/^## Connect$/p' "$(dirname "$0")/../SKILL.md" | sed '1d;$d'
cat "$(dirname "$0")/../references/claude-code.md"
