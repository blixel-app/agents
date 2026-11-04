#!/bin/sh
# Hook 1: runs a typed command and hands its answer to the model as a note, to say in
# one line: Codex desktop shows a stopped turn's text nowhere, and a blocked one only
# as a warning. Codex tells no handoff from a prompt the user typed, so a handoff that
# is a command runs it.
. "$PLUGIN_ROOT/hook.sh"
verb=$(command_of "$(field prompt "$input")")
[ -n "$verb" ] || exit 0

tell() { # text
	note="The Blixel plugin's hook already ran this command, and answered: $1 Tell the user that answer in one short line, and run no command."
	printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' \
		"$(printf '%s' "$note" | tr '[:cntrl:]' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
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
	message=$(field error.message "$answer") || tell "${answer:-Blixel did not answer.}"
	tell "$1$message. $(field error.hint "$answer")"
}

# Hook 2 connects too, and receives: connecting the same session twice answers the
# same connection, so neither waits for the other.
connect() {
	ask_blixel connect
	[ "$(field data.outcome "$answer")" = connected ] || refused "Blixel did not connect: "
	text="Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation."
	[ "$(field data.replaced "$answer")" = true ] &&
		text="$text Another session was connected and no longer receives them."
	tell "$(shared "$text")"
}

status() {
	ask_blixel status
	# With the flag, hook 2 starts a stopped receiver again on this same prompt: the
	# answer waits up to 5 s for the app to see it.
	tries=0
	while connected && [ "$tries" -lt 10 ] && field data.session.connection_id "$answer" >/dev/null &&
		[ "$(field data.session.receiving "$answer")" != true ]; do
		sleep 0.5
		tries=$((tries + 1))
		ask_blixel status
	done
	field error.code "$answer" >/dev/null && refused ""
	if field data.session.connection_id "$answer" >/dev/null; then
		[ "$(field data.session.receiving "$answer")" = true ] ||
			tell 'Connected to the Blixel meeting, but not receiving its handoffs. Type $blixel:connect to receive them.'
		tell "$(shared "Connected to the Blixel meeting. Handoffs from people in it arrive in this conversation.")"
	elif [ "$(field data.connection.agent_pid "$answer")" = "$PPID" ]; then
		tell 'Blixel handoffs go to another Codex conversation. Type $blixel:connect here to move them.'
	elif field data.connection.connection_id "$answer" >/dev/null; then
		tell 'Another session is connected to the Blixel meeting. Type $blixel:connect here to move its handoffs to this one.'
	elif field data.meeting_id "$answer" >/dev/null; then
		tell 'This conversation is not connected to the Blixel meeting. Type $blixel:connect to connect it.'
	fi
	tell "Blixel is not in a meeting."
}

disconnect() {
	ask_blixel disconnect
	case $(field data.outcome "$answer") in
	disconnected) tell "Disconnected from the Blixel meeting. Handoffs stop arriving." ;;
	not_connected) tell "This conversation was not connected to the Blixel meeting." ;;
	esac
	refused ""
}

"$verb"
