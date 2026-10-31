#!/bin/sh
# Hosts this session's relay, as an async hook: a hook is outside Codex's sandbox and
# knows the session, and a sync hook's child would lose the session as its ancestor.
# 30 days is its limit in hooks.json, as Codex kills a hook at its limit, by default
# 10 minutes.
. "$PLUGIN_ROOT/hook.sh"

runs_connect() {
	# Not a mention of it, as in `grep "blixel agent connect"`.
	case " $(field tool_input.command "$input" | tr '\n' ' ')" in
	*[\ \;\&\|\(/]blixel\ agent\ connect* | *[\ \;\&\|\(/]blixel[\"\']\ agent\ connect*) ;;
	*) return 1 ;;
	esac
}

# Only prompt.sh, beside this hook, can tell a typed connect from a handoff saying
# one, and the marker that tells it may be gone by the time this looks.
asked_to_connect() {
	waited=0
	until [ -e "$state/connecting" ]; do
		waited=$((waited + 1))
		[ "$waited" -lt 100 ] || return 1
		sleep 0.02
	done
	rm -f "$state/connecting"
}

leave() {
	rm -f "$state/connected"
	rmdir "$state" 2>/dev/null
	exit 0
}

# A killed relay leaves `connected`, so the next prompt brings it back.
if ! connected; then
	case $input in
	*'"tool_input":'*) runs_connect || leave ;;
	*) asked_to_connect || leave ;;
	esac
fi
mkdir -p "$state"
echo "$PPID" >"$state/connected"
cd "$HOME" || exit 0
# Quitting Codex kills a relay's host before it can clean up after itself.
find "$PLUGIN_DATA" -mindepth 1 -mtime +30 -delete

# Nothing goes before it, a version check included: a command the model runs gives it
# 1 s to attach, and a CLI with no relay only exits 2. Stderr carries its notices, and
# a pipe nobody reads would hold up its renewals. A declined approval ends at its grace.
"$blixel" agent relay --submit "$PLUGIN_ROOT/submit.sh" >/dev/null 2>&1
ended=$?
# 5 is another follower, which is no sign of a healthy one, and over 128 a killed
# relay. Past those there is nothing for a prompt to bring back.
[ "$ended" = 5 ] || [ "$ended" -gt 128 ] || leave
