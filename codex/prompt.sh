#!/bin/sh
# Runs on every prompt, typed or a delivered handoff, so what an ordinary prompt
# costs stays one `case`: Codex writes this JSON with no spaces, and a quote
# inside a prompt is escaped, so nothing in one can look like this key.
. "$PLUGIN_ROOT/codex/hook.sh"
case $input in
*'"prompt":"connect blixel'*) ;;
*)
	set -- "$PLUGIN_DATA/queued.$session".*
	[ -e "$1" ] || exit 0
	;;
esac
prompt=$(printf '%s' "$input" | plutil -extract prompt raw -o - - 2>/dev/null) || exit 0

# Comes first: someone in the call saying the phrase must not run it. A connect
# in a hook never read the skill, so its rules travel with each handoff, which
# also keeps them past a compaction.
set -- "$PLUGIN_DATA/queued.$session.$(printf '%s' "$prompt" | md5 -q)".*
if [ -e "$1" ]; then
	rm -f "$1"
	echo "This prompt is a Blixel handoff, in the session the user connected to their meeting to receive them."
	sed -n '/^## Blixel handoffs$/,/^## Connect$/p' "$PLUGIN_ROOT/skills/connect-agent/SKILL.md" | sed '1d;$d'
	exit 0
fi

case $prompt in
"connect blixel") set -- ;;
"connect blixel ask") set -- --approval ask ;;
"connect blixel direct") set -- --approval direct ;;
*) exit 0 ;;
esac

# Ends the turn before any model sees the prompt.
stop() { # text
	printf '{"continue":false,"stopReason":"%s"}\n' \
		"$(printf '%s' "$1" | tr '[:cntrl:]' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
	exit 0
}

field() { # key path
	printf '%s' "$answer" | plutil -extract "$1" raw -o - - 2>/dev/null
}

said=$("$blixel" agent connect "$@" 2>&1)
answer=$(printf '%s\n' "$said" | tail -n 1)
# An older Blixel queues into a thread itself, with no marker: no rules would come
# with a handoff and one could say the phrase. Its connect is the skill's.
[ "$(field error.code)" = not_in_agent_session ] && exit 0

if [ "$(field data.outcome)" != connected ]; then
	message=$(field error.message) || stop "${answer:-Blixel did not answer.}"
	stop "Blixel did not connect: $message. $(field error.hint)"
fi
text="Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation."
field data.replaced >/dev/null &&
	text="$text Another session was connected and no longer receives them."
case $(ps -o command= -p "$PPID" 2>/dev/null) in
*" app-server"*)
	text="$text This conversation runs on Codex's shared app-server, so a handoff still runs in it after you close this terminal: ask it to disconnect first."
	;;
esac
stop "$text"
