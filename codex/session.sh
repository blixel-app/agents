#!/bin/sh
# Runs as a thread starts. /new and /resume stay in the same process, and a hook
# can't move a connection: on the shared app-server another terminal's thread
# looks the same, so it says where the connection is.
input=$(cat)
session=${input#*\"session_id\":\"}
session=${session%%\"*}
case $session in '' | *[!0-9a-f-]*) exit 0 ;; esac
export BLIXEL_AGENT_PID=$PPID BLIXEL_AGENT_SESSION_KEY=$session
export BLIXEL_AGENT_PROVIDER=codex BLIXEL_AGENT_NAME=Codex

fields=
# A connect the model runs gets this nowhere else.
case $(ps -o command= -p "$PPID" 2>/dev/null) in
*" app-server"*)
	fields='"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"This thread runs on Codex'"'"'s shared app-server. If it connects to Blixel, tell the user a handoff still runs in it after they close this terminal, so they should ask it to disconnect first."}'
	;;
esac

field() { # key path
	printf '%s' "$status" | plutil -extract "$1" raw -o - - 2>/dev/null
}

status=$("$PLUGIN_ROOT/skills/connect-agent/scripts/blixel" agent status 2>/dev/null)
if [ "$(field data.connection.agent_pid)" = "$PPID" ] && ! field data.session.connection_id >/dev/null; then
	fields="${fields:+$fields,}\"systemMessage\":\"Blixel handoffs still go to another Codex conversation. Type: connect blixel here to move them.\""
fi
[ -z "$fields" ] || printf '{%s}\n' "$fields"
