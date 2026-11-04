#!/bin/sh
# Queues one handoff into this Codex thread, where it runs as a turn of its own after
# any turn in progress. `blixel agent receive --deliver-with` runs it once per handoff
# and reads its exit: 0 Codex queued it, 69 it will not run, anything else unknown.
# It runs outside the sandbox, so it finds nothing on PATH.
thread=$BLIXEL_AGENT_SESSION_KEY
[ -n "$thread" ] || exit 69

# The session's own binary, so the same version and CODEX_HOME answer: its image, as
# `ps` gives what it was started as, often a bare name.
codex=$(/usr/sbin/lsof -a -p "$BLIXEL_AGENT_PID" -d txt -Fn 2>/dev/null | /usr/bin/sed -n '/^n/{s///p;q;}')
case $codex in */codex) ;; *) exit 69 ;; esac

# `=` keeps text that starts with - from reading as an option.
said=$("$codex" queue --thread="$thread" --message="$1" </dev/null 2>&1)
case $? in
0)
	case $said in *"Queued message "*" for thread $thread"*) exit 0 ;; esac
	;;
1)
	case $said in *"No active session found"* | *"no rollout found for thread id"*) exit 69 ;; esac
	;;
126 | 127) exit 69 ;;
esac
exit 1
