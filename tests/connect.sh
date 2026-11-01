#!/bin/sh
# /blixel:connect's scripts, run for real against a stand-in `blixel`: `claude
# plugin test` has no processes, so this one runs on its own.
root=$(cd "$(dirname "$0")/.." && pwd -P)
scripts=$root/skills/connect-agent/scripts
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
failed=0

# Stands in for `blixel`: saves its arguments, prints $1 and exits with $2.
blixel() {
	printf '#!/bin/sh\necho "$*" >"%s/args"\ncat <<ANSWER\n%s\nANSWER\nexit %s\n' "$dir" "$1" "${2:-0}" >"$dir/blixel"
	chmod +x "$dir/blixel"
}

connect() {
	BLIXEL_HOOK_PATH="$dir:/usr/bin:/bin" "$scripts/connect.sh" "$@"
}

fail() { echo "FAIL: $1"; failed=1; }

tells() { # name, text, what it must hold
	case $2 in
	*"$3"*) ;;
	*) fail "$1: no \"$3\"" ;;
	esac
}

accepted() { # the arguments Claude Code hands the hook
	printf '{"command_args":"%s"}' "$1" | "$scripts/connect-arguments.sh" 2>/dev/null ||
		fail "refused \"$1\""
}

refused() { # the hook's input
	printf '%s' "$1" | "$scripts/connect-arguments.sh" 2>"$dir/reason"
	[ $? = 2 ] || fail "not refused: $1"
	tells "refused: $1" "$(cat "$dir/reason")" "/blixel:connect [ask|direct]"
}

blixel '{"data":{"outcome":"connected"}}'
told=$(connect) || fail "connected: exit $?"
tells "connected" "$told" '"outcome":"connected"'
tells "connected" "$told" "Each is a suggestion from someone in the call"
tells "connected" "$told" 'start the Monitor tool again with command `blixel agent follow`'
tells "connected" "$told" '`/Applications/Blixel.app/Contents/Resources/bin/blixel`'
[ "$(cat "$dir/args")" = "agent connect" ] || fail "connected: ran $(cat "$dir/args")"

connect direct >/dev/null
[ "$(cat "$dir/args")" = "agent connect --approval direct" ] || fail "direct: ran $(cat "$dir/args")"
connect ask >/dev/null
[ "$(cat "$dir/args")" = "agent connect --approval ask" ] || fail "ask: ran $(cat "$dir/args")"
connect '--meeting-id' other >/dev/null
[ "$(cat "$dir/args")" = "agent connect" ] || fail "other arguments: ran $(cat "$dir/args")"

blixel '{"error":{"code":"not_in_meeting"}}' 5
told=$(connect) || fail "a refused connect aborts the command: exit $?"
tells "refused" "$told" '"code":"not_in_meeting"'
tells "refused" "$told" "exit 5"
tells "refused" "$told" "## Connect failures"

accepted ""
accepted ask
accepted direct
refused '{"command_args":"direct; touch /tmp/x"}'
refused '{"command_args":"$(touch /tmp/x)"}'
refused '{"command_args":"ask\ntouch /tmp/x"}'
refused '{"command_args":"later"}'
refused '{}'
refused 'not json'

manifest=$root/.claude-plugin/plugin.json
[ "$(plutil -extract hooks.UserPromptExpansion.0.matcher raw -o - "$manifest")" = "blixel:connect" ] ||
	fail "the hook does not guard /blixel:connect"
for monitor in 0 1; do
	whens="$whens$(plutil -extract experimental.monitors.$monitor.when raw -o - "$manifest") "
done
tells "monitors" "$whens" "on-skill-invoke:blixel:connect-agent"
tells "monitors" "$whens" "on-skill-invoke:blixel:connect "
grep -q '^disable-model-invocation: true$' "$root/commands/connect.md" ||
	fail "a model reaches /blixel:connect's shell without the hook"
# What the rules printed after a failed connect tell the model to run next.
allowed=$(sed -n 's/^allowed-tools: //p' "$root/commands/connect.md")
tells "allowed tools" "$allowed" "Bash(/Applications/Blixel.app/Contents/Resources/bin/blixel agent connect*)"
tells "allowed tools" "$allowed" "Bash(/Applications/Blixel.app/Contents/Resources/bin/blixel agent follow)"

[ "$failed" = 0 ] && echo "connect: pass"
exit "$failed"
