#!/bin/sh
# The SessionStart hook, run for real against a stand-in `blixel`: `claude
# plugin test` has no processes, so this one runs on its own.
root=$(cd "$(dirname "$0")/.." && pwd -P)
dir=$(mktemp -d)
# Stand-ins for `claude`, each the parent of what receives for its session: a
# Monitor's shell, the mod's receiver, or another command.
claude() { /bin/sh -c 'perl -e "sleep 600" "$1" & wait' sh "$1" 2>/dev/null & }
claude 'agent receive --print-handoffs'
monitor=$!
claude 'agent receive --print-events --confirm-each'
mod=$!
claude 'agent status'
none=$!
trap 'pkill -P "$monitor,$mod,$none"; wait 2>/dev/null; rm -rf "$dir"' EXIT
failed=0

# Prints what the hook tells the session when `agent status` answers $1 and
# exits with $2, on one line.
hook() {
	printf '#!/bin/sh\ntouch "%s"\ncat <<ANSWER\n%s\nANSWER\nexit %s\n' "$dir/asked" "$1" "${2:-0}" >"$dir/blixel"
	chmod +x "$dir/blixel"
	BLIXEL_HOOK_PATH="$dir:/usr/bin:/bin" CLAUDE_PID=${session-$monitor} "$root/skills/connect-agent/scripts/session-start.sh" | tr -s ' \n' ' '
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

route='start the Monitor tool with command `blixel agent receive --print-handoffs`, description `Blixel handoffs`'
restart='When the Monitor stops without an `ended` event, start it again at once'
# A Monitor started outside the skill's turn would ask the user each time.
again="Use the connect-agent skill again first, as its permissions cover the Monitor only while it is in use, then start the Monitor alone: don't connect again"
prompt="act on it as the user's own prompt"

told=$(hook "$(answer '{"claude_pid":7,"connected":true,"connection_id":"c-1","receiving":true}')")
tells "connected" "$told" "connected to the user's Blixel meeting"
tells "connected" "$told" "$route"
tells "connected" "$told" "$restart"
tells "connected" "$told" "$again"
tells "connected" "$told" "$prompt"
tells "connected" "$told" '`/Applications/Blixel.app/Contents/Resources/bin/blixel`'

told=$(hook "$(answer '{"agent_pid":7,"claude_pid":7,"connection_id":"c-1"}')")
tells "connected, a key sorting first" "$told" "$route"

silent "not connected" "$(hook "$(answer '{"claude_pid":7,"receiving":false}')")"
silent "connection null" "$(hook "$(answer '{"claude_pid":7,"connection_id":null}')")"
silent "no session" "$(hook "$(answer null)")"
silent "last connection ended" "$(hook "$(answer \
	'{"claude_pid":7,"ended":{"connection_id":"c-1","end_reason":"disconnected","meeting_id":"m-1"}}')")"
silent "the app closed" "$(hook '' 5)"

connected=$(answer '{"claude_pid":7,"connection_id":"c-1","receiving":true}')

# The mod's receiver alone: it submits handoffs as prompts, so nothing is to add.
rm -f "$dir/asked"
session=$mod
silent "a session whose receiver is the mod" "$(hook "$connected")"
[ ! -e "$dir/asked" ] || { echo "FAIL: a session whose receiver is the mod asked the app"; failed=1; }

rm -f "$dir/asked"
session=$none
silent "a session with no receiver" "$(hook "$connected")"
[ ! -e "$dir/asked" ] || { echo "FAIL: a session with no receiver asked the app"; failed=1; }
unset session

told=$(session='' hook "$connected")
tells "no claude process to look under" "$told" "$route"

[ "$failed" = 0 ] && echo "session-start: pass"
exit "$failed"
