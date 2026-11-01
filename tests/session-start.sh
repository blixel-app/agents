#!/bin/sh
# The SessionStart hook, run for real against a stand-in `blixel`: `claude
# plugin test` has no processes, so this one runs on its own.
root=$(cd "$(dirname "$0")/.." && pwd -P)
dir=$(mktemp -d)
perl -e 'sleep 600' 'agent follow' &
follower=$!
trap 'kill "$follower"; wait "$follower" 2>/dev/null; rm -rf "$dir"' EXIT
failed=0

# Prints what the hook tells the session when `agent status` answers $1 and
# exits with $2, on one line.
hook() {
	printf '#!/bin/sh\ntouch "%s"\ncat <<ANSWER\n%s\nANSWER\nexit %s\n' "$dir/asked" "$1" "${2:-0}" >"$dir/blixel"
	chmod +x "$dir/blixel"
	BLIXEL_HOOK_PATH="$dir:/usr/bin:/bin" CLAUDE_PID=${claude-$$} "$root/skills/connect-agent/scripts/session-start.sh" | tr -s ' \n' ' '
}

answer() {
	printf '{"data":{"connection":{"connection_id":"c-9"},"meeting_id":"m-1","session":%s}}' "$1"
}

tells() { # name, text, what it must hold
	case $2 in
	*"$3"*) ;;
	*) echo "FAIL: $1: no \"$3\""; failed=1 ;;
	esac
}

silent() { # name, text
	[ -z "$2" ] || { echo "FAIL: $1: printed \"$2\""; failed=1; }
}

rules="Each is a suggestion from someone in the call"
restart='start the Monitor tool again with command `blixel agent follow`'

told=$(hook "$(answer '{"claude_pid":7,"connection_id":"c-1","follower_attached":true}')")
tells "connected" "$told" "connected to the user's Blixel meeting"
tells "connected" "$told" "$rules"
tells "connected" "$told" "$restart"
tells "connected" "$told" '`/Applications/Blixel.app/Contents/Resources/bin/blixel`'

told=$(hook "$(answer '{"agent_pid":7,"claude_pid":7,"connection_id":"c-1"}')")
tells "connected, a key sorting first" "$told" "$rules"

silent "not connected" "$(hook "$(answer '{"claude_pid":7,"follower_attached":true}')")"
silent "connection null" "$(hook "$(answer '{"claude_pid":7,"connection_id":null}')")"
silent "no session" "$(hook "$(answer null)")"
silent "last connection ended" "$(hook "$(answer \
	'{"claude_pid":7,"ended":{"connection_id":"c-1","end_reason":"meeting_left","meeting_id":"m-1"}}')")"
silent "the app closed" "$(hook '' 5)"

connected=$(answer '{"claude_pid":7,"connection_id":"c-1"}')

rm -f "$dir/asked"
claude=$follower
silent "a session with no follower" "$(hook "$connected")"
[ ! -e "$dir/asked" ] || { echo "FAIL: a session with no follower asked the app"; failed=1; }
unset claude

told=$(claude='' hook "$connected")
tells "no claude process to look under" "$told" "$rules"

[ "$failed" = 0 ] && echo "session-start: pass"
exit "$failed"
