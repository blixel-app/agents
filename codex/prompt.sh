#!/bin/sh
# What the filter in hooks.json lets through: a prompt that may be a request, and
# every prompt of a session that has connected, as any of them can be a handoff.
. "$PLUGIN_ROOT/hook.sh"
prompt=$(field prompt "$input")

# Comes first: someone in the call saying a phrase must not run it. A connect in a
# hook never read the skill, so its rules travel with each handoff, which also keeps
# them past a compaction.
set -- "$state/queued.$(printf '%s' "$prompt" | md5 -q)".*
if [ -e "$1" ]; then
	rm -f "$1"
	echo "This prompt is a Blixel handoff, in the session the user connected to their meeting to receive them."
	sed -n '/^## Blixel handoffs$/,/^## Connect$/p' "$PLUGIN_ROOT/skills/connect-agent/SKILL.md" | sed '1d;$d'
	exit 0
fi

# The whole prompt, in any case: $blixel:connect as the picker writes it, or a plain
# spelling.
words=$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]')
verb=
approval=
case $words in
'$blixel:status') verb=status ;;
'$blixel:disconnect') verb=disconnect ;;
*' ask') approval=ask words=${words% ask} ;;
*' direct') approval=direct words=${words% direct} ;;
esac
case $words in
'$blixel:connect' | 'connect blixel' | 'blixel connect' | 'blixel:connect') verb=connect ;;
esac
[ -n "$verb" ] || exit 0

# Ends the turn before any model sees the prompt.
stop() { # text
	printf '{"continue":false,"stopReason":"%s"}\n' \
		"$(printf '%s' "$1" | tr '[:cntrl:]' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
	exit 0
}

ask_blixel() { # arguments; leaves its last line in $answer
	answer=$("$blixel" agent "$@" 2>&1 | tail -n 1)
	# An older Blixel queues into a thread itself, with no marker: no rules would
	# come with a handoff and one could say a phrase. What it answers is the skill's.
	[ "$(field error.code "$answer")" != not_in_agent_session ] || exit 0
}

shared() { # text; adds what a thread on the shared app-server must know
	case $(ps -o command= -p "$PPID" 2>/dev/null) in
	*" app-server"*)
		echo "$1 This conversation runs on Codex's shared app-server, so a handoff still runs in it after you close this terminal: ask it to disconnect first."
		;;
	*) echo "$1" ;;
	esac
}

refused() { # what failed
	message=$(field error.message "$answer") || stop "${answer:-Blixel did not answer.}"
	stop "$1$message. $(field error.hint "$answer")"
}

connect() {
	# Tells relay.sh, running beside this hook, that this prompt is a connect.
	if ! connected; then
		mkdir -p "$state"
		: >"$state/connecting"
	fi
	ask_blixel connect ${approval:+--approval "$approval"}
	[ "$(field data.outcome "$answer")" = connected ] || refused "Blixel did not connect: "
	text="Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation."
	field data.replaced "$answer" >/dev/null &&
		text="$text Another session was connected and no longer receives them."
	stop "$(shared "$text")"
}

status() {
	ask_blixel status
	field error.code "$answer" >/dev/null && refused ""
	if field data.session.connection_id "$answer" >/dev/null; then
		stop "$(shared "Connected to the Blixel meeting. Handoffs from people in it arrive in this conversation.")"
	elif [ "$(field data.connection.agent_pid "$answer")" = "$PPID" ]; then
		stop 'Blixel handoffs go to another Codex conversation. Type $blixel:connect here to move them.'
	elif field data.connection.connection_id "$answer" >/dev/null; then
		stop 'Another session is connected to the Blixel meeting. Type $blixel:connect here to move its handoffs to this one.'
	elif field data.meeting_id "$answer" >/dev/null; then
		stop 'This conversation is not connected to the Blixel meeting. Type $blixel:connect to connect it.'
	fi
	stop "Blixel is not in a meeting."
}

disconnect() {
	ask_blixel disconnect
	case $(field data.outcome "$answer") in
	disconnected) stop "Disconnected from the Blixel meeting. Handoffs stop arriving." ;;
	not_connected) stop "This conversation was not connected to the Blixel meeting." ;;
	esac
	refused ""
}

"$verb"
