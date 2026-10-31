#!/bin/sh
# Runs on every prompt, typed or a delivered handoff, so what an ordinary prompt
# costs stays one `case`: Codex writes this JSON with no spaces, and a quote
# inside a prompt is escaped, so nothing in one can look like this key.
input=$(cat)
session=${input#*\"session_id\":\"}
session=${session%%\"*}
case $session in '' | *[!0-9a-f-]*) exit 0 ;; esac
case $input in
*'"prompt":"connect blixel'*) ;;
*)
	set -- "$PLUGIN_DATA/queued.$session".*
	[ -e "$1" ] || exit 0
	;;
esac
skill=$PLUGIN_ROOT/skills/connect-agent
prompt=$(printf '%s' "$input" | plutil -extract prompt raw -o - - 2>/dev/null) || exit 0

# Comes first: someone in the call saying the phrase must not run it. A connect
# in a hook never read the skill, so its rules travel with each handoff, which
# also keeps them past a compaction.
set -- "$PLUGIN_DATA/queued.$session.$(printf '%s' "$prompt" | /sbin/md5 -q)".*
if [ -e "$1" ]; then
	rm -f "$1"
	echo "This prompt is a Blixel handoff, in the session the user connected to their meeting to receive them."
	sed -n '/^## Blixel handoffs$/,/^## Connect$/p' "$skill/SKILL.md" | sed '1d;$d'
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
		"$(printf '%s' "$1" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
	exit 0
}

connect() {
	said=$("$skill/scripts/blixel" agent connect "$@" 2>&1)
	answer=$(printf '%s\n' "$said" | tail -n 1)
}

field() { # key path
	printf '%s' "$answer" | plutil -extract "$1" raw -o - - 2>/dev/null
}

export BLIXEL_AGENT_PID=$PPID BLIXEL_AGENT_SESSION_KEY=$session
export BLIXEL_AGENT_PROVIDER=codex BLIXEL_AGENT_NAME=Codex
connect "$@"
# An older Blixel knows Codex only by its thread, and queues into it itself.
if [ "$(field error.code)" = not_in_agent_session ]; then
	export CODEX_THREAD_ID=$session
	connect "$@"
fi

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
