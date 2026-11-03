#!/bin/sh
# Hook 2: hosts this session's receiver, as an async hook: a hook is outside Codex's
# sandbox and knows the session, and a sync hook's child would lose Codex as its
# ancestor. 30 days is its limit in hooks.json, as Codex kills a hook at its limit,
# by default 10 minutes.
. "$PLUGIN_ROOT/hook.sh"

leave() {
	rm -f "$state/connected"
	rmdir "$state" 2>/dev/null
	exit 0
}

case $(command_of "$(field prompt "$input")") in
connect)
	# Hook 1 connects beside this one; whichever comes first, the second gets the same
	# connection, and this receive follows this connect.
	answer=$("$blixel" agent connect 2>/dev/null | tail -n 1)
	[ "$(field data.outcome "$answer")" = connected ] || leave
	;;
*) connected || leave ;;
esac
mkdir -p "$state"
echo "$PPID" >"$state/connected"
cd "$HOME" || exit 0
# Quitting Codex kills a receiver's host before it can clean up after itself.
find "$PLUGIN_DATA" -mindepth 1 -mtime +30 -delete

# Its last line says how it stopped. The hook reads both streams to the end: a pipe
# nobody read would hold it up.
last=$("$blixel" agent receive --deliver-with "$PLUGIN_ROOT/skills/connect-agent/scripts/deliver/codex.sh" \
	</dev/null 2>&1 | tail -n 1)
# With no `ended` and no error, or `cancelled`, it was stopped from outside: the next
# prompt starts it again. `received_elsewhere` keeps the flag for a receiver still live.
case $(field event "$last") in
ended) [ "$(field data.reason "$last")" = received_elsewhere ] || leave ;;
*) case $(field error.code "$last") in '' | cancelled) ;; *) leave ;; esac ;;
esac
