#!/bin/sh
# Hook 1: answers a typed command and ends the turn before any model sees it. Codex
# tells no handoff from a prompt the user typed, so a handoff that is a command runs it.
. "$PLUGIN_ROOT/hook.sh"
verb=$(command_of "$(field prompt "$input")")
[ -n "$verb" ] || exit 0

stop() { # text
	printf '{"continue":false,"stopReason":"%s"}\n' \
		"$(printf '%s' "$1" | tr '[:cntrl:]' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
	exit 0
}

ask_blixel() { # arguments; leaves its last line in $answer
	answer=$("$blixel" agent "$@" 2>&1 | tail -n 1)
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

# Hook 2 connects too, and receives: connecting the same session twice answers the
# same connection, so neither waits for the other.
connect() {
	ask_blixel connect
	[ "$(field data.outcome "$answer")" = connected ] || refused "Blixel did not connect: "
	text="Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation."
	[ "$(field data.replaced "$answer")" = true ] &&
		text="$text Another session was connected and no longer receives them."
	stop "$(shared "$text")"
}

status() {
	ask_blixel status
	field error.code "$answer" >/dev/null && refused ""
	if field data.session.connection_id "$answer" >/dev/null; then
		# With the flag, hook 2 is starting its receiver again on this same prompt.
		[ "$(field data.session.receiving "$answer")" = true ] || connected ||
			stop 'Connected to the Blixel meeting, but not receiving its handoffs. Type $blixel:connect to receive them.'
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
