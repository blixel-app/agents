#!/bin/sh
# After /clear or a compaction the conversation no longer holds the skill's text,
# while the session's connection and Monitor carry on: without it the model takes
# handoffs for background notifications, and does not start the Monitor again.
#
# Only a Monitor's receiver needs it: the mod submits handoffs as prompts. A Monitor
# runs its command in a shell that is a child of `claude`, and only it prints
# handoffs as lines. A session with no such child stays out of Blixel. Only a clean
# "no match" says so: anything else asks the app.
. "${0%/*}/path.sh"
pgrep -q -P "${CLAUDE_PID-}" -f 'agent receive --print-handoffs' 2>/dev/null
[ "$?" = 1 ] && exit 0
status=$("${0%/*}/blixel" agent status 2>/dev/null) || exit 0
# Parsed, not matched: the session's other keys change between app versions,
# and its ended connection holds a connection_id of its own.
printf '%s' "$status" | plutil -extract data.session.connection_id raw -o - - >/dev/null 2>&1 || exit 0
echo "This Claude Code session is connected to the user's Blixel meeting, and \`blixel agent receive --print-handoffs\` receives its handoffs in the background: the user connected it with the Blixel connect-agent skill before this conversation was cleared or compacted."
cat "${0%/*}/../references/claude.md"
