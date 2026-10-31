#!/bin/sh
# Queues one handoff into this thread: `agent relay` runs it once for each, and never
# again. It answers 0 once Codex says it queued this thread's message, 69 if Codex
# will not run it, and 1 for any doubt, as the relay reads it.
text=$1
session=$BLIXEL_AGENT_SESSION_KEY

# The session's own, so the same version and CODEX_HOME answer: its image, as `ps`
# gives what it was started as, often a bare name.
codex=$(lsof -a -p "$BLIXEL_AGENT_PID" -d txt -Fn 2>/dev/null | sed -n '/^n/{s///p;q;}')
case $codex in */codex) ;; *) codex=codex ;; esac

# Tells prompt.sh this prompt is a handoff. A hash, so no text is on disk. It stays
# past the relay: Codex may still hold the prompt.
mark=$PLUGIN_DATA/$session/queued.$(printf '%s' "$text" | md5 -q).$BLIXEL_HANDOFF_ID
: >"$mark"

# `=` keeps text that starts with - from reading as an option.
said=$("$codex" queue --thread="$session" --message="$text" </dev/null 2>&1)
case $? in
0)
	case $said in *"Queued message"*) case $said in *"$session"*) exit 0 ;; esac ;; esac
	;;
1)
	case $said in
	*"No active session found"* | *"no rollout found for thread id"*)
		rm -f "$mark"
		exit 69
		;;
	esac
	;;
126 | 127)
	rm -f "$mark"
	exit 69
	;;
esac
exit 1
