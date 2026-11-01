#!/bin/sh
# After /clear or a compaction the conversation no longer holds the skill's
# text, while the session's connection and monitor carry on: without it the
# model refuses handoffs as background notifications.
#
# A session's follower is a child of its `claude`: the mod's itself, a monitor's
# as the shell that runs it. A session with none has no connection to keep and
# stays out of Blixel. Only a clean "no match" says so: anything else asks the app.
. "${0%/*}/path.sh"
pgrep -q -P "${CLAUDE_PID-}" -f 'agent follow' 2>/dev/null
[ "$?" = 1 ] && exit 0
status=$("${0%/*}/blixel" agent status 2>/dev/null) || exit 0
# Parsed, not matched: the session's other keys change between app versions,
# and its ended connection holds a connection_id of its own.
printf '%s' "$status" | plutil -extract data.session.connection_id raw -o - - >/dev/null 2>&1 || exit 0
echo "This Claude Code session is connected to the user's Blixel meeting: the user ran the Blixel connect-agent skill to receive handoffs before this conversation was cleared or compacted."
sed -n '/^## Blixel handoffs$/,/^## Connect$/p' "${0%/*}/../SKILL.md" | sed '1d;$d'
cat "${0%/*}/../references/claude-code.md"
